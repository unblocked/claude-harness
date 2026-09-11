import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Condition, Config, DiffStats, UnblockedCall } from "./types.ts";
import { runClaude, createWorktree, removeWorktree } from "./claude.ts";
import { printReport, writeJsonResult, writeHtmlReport } from "./report.ts";
import { estimateCost, formatCost, formatDiffSummary, formatDuration, log } from "./util.ts";
import { commitsBetween, git, isAncestor, refsContaining, snapshotRefs, tryGit } from "./git.ts";

// The most recent commit in this worktree's HEAD reflog that descends from the
// base and is not already part of history that existed before the run. Used only
// when HEAD itself is not ahead of the base — i.e. the agent committed somewhere
// and then checked the base back out, or reset away from its work.
//
// "Already existed" is decided by asking which refs contain the candidate and
// whether any of them still sits at its pre-run sha: a pre-existing branch the
// agent merely checked out to read is excluded; one it committed onto has moved
// and so counts. Most recent wins, so history the agent deliberately reset away
// from is not preferred over its later work.
export function findAgentTip(cwd: string, baseSha: string, refsBefore: Map<string, string> | null): { sha: string; commits: number } | null {
  const reflog = tryGit(cwd, ["reflog", "show", "--format=%H", "HEAD"], "reading worktree reflog");
  if (reflog === null) return null;
  for (const raw of reflog.split("\n")) {
    const sha = raw.trim();
    if (!sha || sha === baseSha || !isAncestor(cwd, baseSha, sha)) continue;
    if (refsBefore) {
      const containing = refsContaining(cwd, sha);
      const preExisting = [...containing].some(([ref, tip]) => refsBefore.get(ref) === tip);
      if (preExisting) continue;
    }
    const commits = commitsBetween(cwd, baseSha, sha);
    if (commits > 0) return { sha, commits };
  }
  return null;
}

interface Captured { diff: string; stats: DiffStats }

function numstatTotals(numstat: string): { files: number; added: number; removed: number } {
  let files = 0, added = 0, removed = 0;
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    if (m[1] !== "-") added += parseInt(m[1], 10);
    if (m[2] !== "-") removed += parseInt(m[2], 10);
  }
  return { files, added, removed };
}

// Everything the agent changed relative to the commit the worktree started from.
//
// Exactly one of two views is reported, never both, so nothing is counted twice:
//   - the working tree vs the base, when HEAD is at or ahead of the base (the
//     normal case: commits plus whatever is still uncommitted, plus untracked);
//   - the reflog tip vs the base, when the agent committed and then moved HEAD
//     back off that work. Anything uncommitted on top of the moved HEAD is not
//     included; it is logged instead.
// Line counts come from --numstat, which stays small however big the change is;
// the diff text is captured separately and marked truncated if it will not fit.
export function captureDiff(cwd: string, baseSha: string, refsBefore: Map<string, string> | null): Captured {
  const empty = (diff: string): Captured => ({ diff, stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 } });

  const head = tryGit(cwd, ["rev-parse", "HEAD"], "resolving HEAD for diff capture")?.trim();
  if (!head) return empty("(failed to capture diff)");

  let range: string[];
  let commits: number;
  let includeWorkingTree: boolean;
  if (head !== baseSha && isAncestor(cwd, baseSha, head)) {
    range = [baseSha]; commits = commitsBetween(cwd, baseSha, head); includeWorkingTree = true;
  } else {
    const tip = findAgentTip(cwd, baseSha, refsBefore);
    if (tip) {
      range = [baseSha, tip.sha]; commits = tip.commits; includeWorkingTree = false;
      const dirty = (tryGit(cwd, ["status", "--porcelain"], "checking working tree") ?? "").trim();
      if (dirty) log(`Worktree has uncommitted changes on top of ${head.slice(0, 7)} that are not in the captured diff (agent's committed work at ${tip.sha.slice(0, 7)} is)`);
    } else {
      range = [baseSha]; commits = 0; includeWorkingTree = true;
    }
  }

  const numstat = tryGit(cwd, ["diff", "--numstat", ...range], "computing diff stats");
  if (numstat === null) return empty("(failed to capture diff)");
  const totals = numstatTotals(numstat);

  const untracked = includeWorkingTree
    ? (tryGit(cwd, ["ls-files", "--others", "--exclude-standard"], "listing untracked files") ?? "").split("\n").map(f => f.trim()).filter(Boolean)
    : [];
  for (const file of untracked) {
    // exit code 1 is normal for --no-index when files differ, so don't go through tryGit
    try { git(cwd, ["diff", "--no-index", "--numstat", "/dev/null", file]); } catch (e) {
      const out = (e as { stdout?: Buffer }).stdout?.toString() ?? "";
      const t = numstatTotals(out); totals.files += t.files; totals.added += t.added; totals.removed += t.removed;
    }
  }

  const stats: DiffStats = { filesChanged: totals.files, linesAdded: totals.added, linesRemoved: totals.removed, commits };

  let text: string;
  try {
    text = git(cwd, ["diff", ...range]);
    for (const file of untracked) {
      try { git(cwd, ["diff", "--no-index", "/dev/null", file]); } catch (e) {
        text += (e as { stdout?: Buffer }).stdout?.toString() ?? "";
      }
    }
  } catch (err) {
    log(`Diff text too large to keep (${(err as Error).message.split("\n")[0]}); stats are still exact`);
    text = `(diff text too large to keep: ${formatDiffSummary(stats)})`;
    stats.truncated = true;
  }

  return { diff: text || "(no changes)", stats };
}

function extractUnblockedCalls(toolCalls: { name: string; args: Record<string, unknown>; mcpServer?: string }[]): UnblockedCall[] {
  const calls: UnblockedCall[] = [];
  for (const tc of toolCalls) {
    const isUbMcp = tc.mcpServer?.toLowerCase().includes("unblocked")
      || tc.name.toLowerCase().includes("unblocked");
    const isUbCli = tc.name === "Bash"
      && /^unblocked\s+context[_-]/.test((tc.args.command as string) ?? "");

    if (isUbMcp) {
      const tool = tc.name.split(/__|::/).pop() ?? tc.name;
      const query = (tc.args.query as string) ?? (tc.args.url as string) ?? (tc.args.urls as string);
      calls.push({ tool, query: query ?? undefined });
    } else if (isUbCli) {
      const cmd = (tc.args.command as string) ?? "";
      const match = cmd.match(/^unblocked\s+(context[_-]\w+)/);
      if (match) {
        const tool = match[1];
        const queryFlag = cmd.match(/--query\s+["']?(.+?)["']\s*(?:--|$)/)?.[1];
        const positional = cmd.match(/(?:--effort\s+\w+\s+)?["']([^"']+)["']\s*$/)?.[1]
          ?? cmd.match(/(?:--effort\s+\w+\s+)(\S.+)$/)?.[1];
        calls.push({ tool, query: queryFlag ?? positional ?? undefined });
      }
    }
  }
  return calls;
}

const BASELINE_NUDGE = `IMPORTANT: Do NOT use any Unblocked tools, Unblocked skills, or Unblocked CLI commands. Do NOT call context_research, context_get_urls, or any tool with "unblocked" in its name. Do NOT run the "unblocked" CLI binary. You may use all other tools, MCP servers, plugins, and skills.

TASK:
`;

const UNBLOCKED_MCP_NUDGE = `IMPORTANT: Before doing anything else, call the Unblocked context_research MCP tool with a detailed query describing the task (effort: low). This is your FIRST action.

After that initial call, there are points in your planning and implementation flow where additional calls to context_research would be useful (always effort: low):
- After planning: check for operational risks, previous incidents, deployment gotchas, or rejected approaches related to your plan
- Before implementing unfamiliar patterns: verify conventions and team decisions

If you need to expand on something context_research surfaced, use context_get_urls to fetch additional detail.

You may also use all other tools, MCP servers, plugins, and skills as needed.

TASK:
`;

const UNBLOCKED_CLI_NUDGE = `IMPORTANT: Before doing anything else, run the Unblocked CLI to research this task. This is your FIRST action:
unblocked context-research --effort low --query "<detailed query describing the task>"

After that initial call, continue using context-research throughout the task (always --effort low):
- After planning: check for operational risks, previous incidents, deployment gotchas, or rejected approaches related to your plan
- Before implementing unfamiliar patterns: verify conventions and team decisions

If you need to expand on something context-research surfaced, use context-get-urls to fetch additional detail.

You may also use all other tools, MCP servers, plugins, and skills as needed.

TASK:
`;

async function runArm(config: Config, condition: Condition, outDir: string, refsBefore: Map<string, string> | null): Promise<ArmResult> {
  let nudge: string;
  if (condition === "baseline") {
    nudge = BASELINE_NUDGE;
  } else if (config.cliMode) {
    nudge = UNBLOCKED_CLI_NUDGE;
  } else {
    nudge = UNBLOCKED_MCP_NUDGE;
  }
  const prompt = nudge + config.task;

  const suffix = randomBytes(4).toString("hex");
  const wtName = `${condition}-${suffix}`;

  log(`[${condition}] Creating worktree: ${wtName}`);
  const { path: wtPath, baseSha } = createWorktree(config.repo, wtName, config.branch);
  log(`[${condition}] Worktree at: ${wtPath} (base ${baseSha.slice(0, 7)})`);

  log(`[${condition}] Running Claude Code...`);
  const runResult = await runClaude({
    prompt,
    worktreePath: wtPath,
    model: config.model,
    condition,
    timeoutMs: config.timeoutSeconds * 1000,
    outDir,
    blockUnblocked: condition === "baseline",
  });
  log(`[${condition}] Done: ${formatDuration(runResult.durationMs)}, ${runResult.assistantTurns} turns, exit=${runResult.exitCode}${runResult.timedOut ? " (TIMED OUT)" : ""}`);

  const { diff, stats: diffStats } = captureDiff(wtPath, baseSha, refsBefore);
  log(`[${condition}] Diff: ${formatDiffSummary(diffStats)}`);

  const unblockedCalls = extractUnblockedCalls(runResult.toolCalls);
  if (unblockedCalls.length > 0) {
    log(`[${condition}] Unblocked calls: ${unblockedCalls.length}`);
  }

  const cost = runResult.totalCostUsd ?? estimateCost(config.model, runResult.tokenUsage);

  return { condition, run: { ...runResult, worktreePath: wtPath }, diff, diffStats, unblockedCalls, estimatedCost: cost };
}

export async function run(config: Config): Promise<ComparisonResult> {
  const startTime = Date.now();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(process.cwd(), "results", `run-${timestamp}`);
  const baselineDir = path.join(outDir, "baseline");
  const unblockedDir = path.join(outDir, "unblocked");
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.mkdirSync(unblockedDir, { recursive: true });

  // One snapshot of every ref before either worktree exists. `worktree add
  // --detach` creates no refs, so both arms share it. Used to separate the
  // agent's commits from pre-existing history and to find branches it created.
  const refsBefore = snapshotRefs(config.repo);

  let baseline: ArmResult;
  let unblocked: ArmResult;

  try {
    [baseline, unblocked] = await Promise.all([
      runArm(config, "baseline", baselineDir, refsBefore),
      runArm(config, "unblocked", unblockedDir, refsBefore),
    ]);
  } finally {
    if (!config.keepWorktrees) {
      log("Cleaning up worktrees...");
      for (const arm of [baseline!, unblocked!]) {
        if (!arm) continue;
        removeWorktree(config.repo, path.basename(arm.run.worktreePath), refsBefore);
      }
    }
  }

  const result: ComparisonResult = {
    repo: config.repo,
    task: config.task,
    branch: config.branch,
    model: config.model,
    baseline,
    unblocked,
    totalDurationMs: Date.now() - startTime,
    totalEstimatedCost: baseline.estimatedCost + unblocked.estimatedCost,
  };

  printReport(result);
  writeJsonResult(result, outDir);
  const htmlPath = writeHtmlReport(result, outDir);

  log(`Results: ${outDir}`);
  log(`HTML report: ${htmlPath}`);
  log(`Total time: ${formatDuration(result.totalDurationMs)}`);
  log(`Total cost: ${formatCost(result.totalEstimatedCost)}`);

  try {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execSync(`${opener} "${htmlPath}"`);
  } catch {}

  return result;
}
