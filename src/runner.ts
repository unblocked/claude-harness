import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Condition, Config, DiffStats, UnblockedCall } from "./types.ts";
import { runClaude, createWorktree, removeWorktree } from "./claude.ts";
import { printReport, writeJsonResult, writeHtmlReport } from "./report.ts";
import { estimateCost, formatCost, formatDiffSummary, formatDuration, log } from "./util.ts";
import { git, isAncestor, snapshotRefs, tryGit } from "./git.ts";
import { attribute } from "./attribution.ts";
import { assessQuality } from "./quality.ts";
import { assessImpact } from "./impact.ts";

// The commits the agent made: everything reachable from any commit this
// worktree's HEAD ever pointed at (its reflog, plus HEAD now) that was not
// already reachable from a ref when the run started. Checking out a
// pre-existing branch contributes nothing; committing onto one contributes the
// new commits; committing then resetting or switching away still contributes.
export function agentCommits(cwd: string, baseSha: string, refsBefore: Map<string, string> | null): Set<string> {
  const heads = new Set<string>();
  const head = tryGit(cwd, ["rev-parse", "HEAD"], "resolving HEAD")?.trim();
  if (head) heads.add(head);
  for (const sha of (tryGit(cwd, ["reflog", "show", "--format=%H", "HEAD"], "reading worktree reflog") ?? "").split("\n")) if (sha.trim()) heads.add(sha.trim());
  if (heads.size === 0) return new Set();
  const exclude = new Set<string>([baseSha, ...(refsBefore ? refsBefore.values() : [])]);
  const out = tryGit(cwd, ["rev-list", ...heads, "--not", ...exclude], "listing agent commits");
  return new Set((out ?? "").split("\n").map(l => l.trim()).filter(Boolean));
}

// Most recent reflog entry that is an agent commit descending from the base.
function latestAgentTip(cwd: string, baseSha: string, agent: Set<string>): string | null {
  for (const raw of (tryGit(cwd, ["reflog", "show", "--format=%H", "HEAD"], "reading worktree reflog") ?? "").split("\n")) {
    const sha = raw.trim();
    if (sha && agent.has(sha) && isAncestor(cwd, baseSha, sha)) return sha;
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
// Exactly one view is reported, never two concatenated:
//   - HEAD is an agent commit (or the base) → the working tree vs the base:
//     the agent's commits plus whatever is still uncommitted, plus untracked;
//   - HEAD is some pre-existing commit (the agent checked out another branch)
//     → the working tree vs HEAD if it is dirty, else the latest agent commit
//     found in the reflog vs the base, else nothing.
// Commit count is the number of agent commits reachable from the reported
// view. Line counts come from --numstat; the diff text is captured separately
// and replaced by a summary when it will not fit.
export function captureDiff(cwd: string, baseSha: string, refsBefore: Map<string, string> | null): Captured & { agent: Set<string> } {
  const agent = agentCommits(cwd, baseSha, refsBefore);
  const fail = (diff: string): Captured & { agent: Set<string> } => ({ diff, stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 }, agent });

  const head = tryGit(cwd, ["rev-parse", "HEAD"], "resolving HEAD for diff capture")?.trim();
  if (!head) return fail("(failed to capture diff)");
  const dirty = (tryGit(cwd, ["status", "--porcelain"], "checking working tree") ?? "").trim().length > 0;
  const countIn = (tip: string) => (tryGit(cwd, ["rev-list", `${baseSha}..${tip}`], "counting agent commits") ?? "").split("\n").filter(l => agent.has(l.trim())).length;

  let range: string[];
  let commits: number;
  let includeWorkingTree: boolean;
  if (agent.has(head)) {
    // HEAD is the agent's own commit: working tree vs base covers commits + uncommitted.
    range = [baseSha]; commits = countIn(head); includeWorkingTree = true;
  } else if (dirty) {
    // HEAD is the base or some pre-existing commit and the tree is dirty: the tree is the latest state.
    if (agent.size) log(`Worktree HEAD ${head.slice(0, 7)} is not an agent commit and the tree is dirty; reporting uncommitted changes (${agent.size} agent commit(s) in the reflog are not in the diff)`);
    range = [head]; commits = 0; includeWorkingTree = true;
  } else {
    // Clean tree at a non-agent commit: the agent's work, if any, is a commit it moved away from.
    const tip = latestAgentTip(cwd, baseSha, agent);
    if (tip) { range = [baseSha, tip]; commits = countIn(tip); includeWorkingTree = false; }
    else { range = [head]; commits = 0; includeWorkingTree = true; }
  }

  const numstat = tryGit(cwd, ["diff", "--numstat", ...range], "computing diff stats");
  if (numstat === null) return fail("(failed to capture diff)");
  const totals = numstatTotals(numstat);

  // --no-index exits 1 when the files differ (always, against /dev/null); anything else is a real failure.
  const noIndex = (file: string, extra: string[]): string | null => {
    try { git(cwd, ["diff", "--no-index", ...extra, "/dev/null", file]); return ""; } catch (e) {
      const err = e as { status?: number | null; code?: string; stdout?: Buffer };
      if (err.status === 1) return err.stdout?.toString() ?? "";
      log(`git diff --no-index failed for ${file}: ${err.code ?? `exit ${err.status}`}`);
      return null;
    }
  };
  const untracked = includeWorkingTree
    ? (tryGit(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], "listing untracked files") ?? "").split("\0").filter(Boolean)
    : [];
  for (const file of untracked) {
    const t = numstatTotals(noIndex(file, ["--numstat"]) ?? "");
    totals.files += t.files; totals.added += t.added; totals.removed += t.removed;
  }

  const stats: DiffStats = { filesChanged: totals.files, linesAdded: totals.added, linesRemoved: totals.removed, commits };

  let text: string;
  try {
    text = git(cwd, ["diff", ...range]);
  } catch (e) {
    const err = e as { code?: string; status?: number | null };
    if (err.code === "ENOBUFS") {
      log("Diff text too large to keep; stats are still exact");
      text = `(diff text too large to keep: ${formatDiffSummary(stats)})`;
      stats.truncated = true;
    } else {
      log(`git diff failed: ${err.code ?? `exit ${err.status}`}`);
      return { ...fail("(failed to capture diff)"), stats };
    }
  }
  if (!stats.truncated) {
    for (const file of untracked) {
      const part = noIndex(file, []);
      if (part === null) { text += `\n(diff for ${file} unavailable)\n`; continue; }
      text += part;
    }
  }
  return { diff: text || "(no changes)", stats, agent };
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

// Agent commits per arm, kept for branch cleanup after the diff is captured.
const agentCommitsByArm = new Map<Condition, Set<string>>();

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

  const { diff, stats: diffStats, agent } = captureDiff(wtPath, baseSha, refsBefore);
  log(`[${condition}] Diff: ${formatDiffSummary(diffStats)}`);
  agentCommitsByArm.set(condition, agent);

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
        removeWorktree(config.repo, path.basename(arm.run.worktreePath), refsBefore, agentCommitsByArm.get(arm.condition) ?? new Set());
      }
    }
  }

  if (config.analystModel) {
    for (const arm of [baseline, unblocked]) {
      const a = attribute(arm.run.jsonlPath, config.task, arm.run.totalCostUsd ?? arm.estimatedCost, config.analystModel, arm.condition);
      if (a) arm.attribution = a;
    }
  }

  const result: ComparisonResult = {
    repo: config.repo,
    task: config.task,
    branch: config.branch,
    model: config.model,
    baseline,
    unblocked,
    totalDurationMs: Math.max(baseline.run.durationMs, unblocked.run.durationMs),
    totalEstimatedCost: baseline.estimatedCost + unblocked.estimatedCost,
  };
  if (config.analystModel) {
    const q = assessQuality(result, config.analystModel);
    if (q) result.quality = q;
    const im = assessImpact(result, config.analystModel);
    if (im) result.impact = im;
  }
  result.analysisCostUsd = (baseline.attribution?.analystCostUsd ?? 0) + (unblocked.attribution?.analystCostUsd ?? 0) + (result.quality?.judgeCostUsd ?? 0) + (result.impact?.costUsd ?? 0);
  log(`Experiment wall time ${formatDuration(Date.now() - startTime)} incl. analysis`);

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
