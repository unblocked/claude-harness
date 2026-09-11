import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Condition, Config, DiffStats, UnblockedCall } from "./types.ts";
import { runClaude, createWorktree, removeWorktree } from "./claude.ts";
import { printReport, writeJsonResult, writeHtmlReport } from "./report.ts";
import { estimateCost, formatCost, formatDuration, log } from "./util.ts";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: "pipe", maxBuffer: 2 * 1024 * 1024 }).toString();
}

function isAncestor(cwd: string, ancestor: string, sha: string): boolean {
  try { execSync(`git merge-base --is-ancestor ${ancestor} ${sha}`, { cwd, stdio: "pipe" }); return true; } catch { return false; }
}

// The commit holding the agent's work. Usually HEAD — but an agent that commits
// on a branch and then checks out something else (or `reset --hard`s) leaves
// HEAD back at the base, and a plain `git diff base` sees nothing. The
// worktree's HEAD reflog remembers every commit HEAD pointed at, so pick the
// descendant of the base that is furthest ahead of it.
export function findAgentTip(cwd: string, baseSha: string): { sha: string; commits: number } {
  const candidates = new Set<string>();
  try { candidates.add(git(cwd, "rev-parse HEAD").trim()); } catch {}
  try {
    for (const sha of git(cwd, "reflog show --format=%H HEAD").split("\n")) {
      if (sha.trim()) candidates.add(sha.trim());
    }
  } catch {}

  let best = { sha: baseSha, commits: 0 };
  for (const sha of candidates) {
    if (sha === baseSha || !isAncestor(cwd, baseSha, sha)) continue;
    const commits = parseInt(git(cwd, `rev-list --count ${baseSha}..${sha}`).trim(), 10) || 0;
    if (commits > best.commits) best = { sha, commits };
  }
  return best;
}

// Everything the agent changed relative to the commit the worktree started
// from: commits it made (found via findAgentTip, wherever HEAD ended up) plus
// whatever is still uncommitted in the working tree, plus untracked files.
export function captureDiff(cwd: string, baseSha: string): { diff: string; commits: number } {
  try {
    const tip = findAgentTip(cwd, baseSha);
    const head = git(cwd, "rev-parse HEAD").trim();

    let diff = "";
    if (head === tip.sha) {
      // Normal case: HEAD is where the work is. One diff covers commits + working tree.
      diff += git(cwd, `diff ${baseSha}`);
    } else {
      // Agent moved HEAD away from its work. Committed work from the reflog tip,
      // then anything uncommitted on top of wherever HEAD is now.
      if (tip.commits > 0) diff += git(cwd, `diff ${baseSha} ${tip.sha}`);
      diff += git(cwd, "diff HEAD");
    }

    const untracked = git(cwd, "ls-files --others --exclude-standard").trim();
    if (untracked) {
      for (const file of untracked.split("\n").filter(Boolean)) {
        const result = spawnSync("git", ["diff", "--no-index", "/dev/null", file], {
          cwd, stdio: "pipe", maxBuffer: 1024 * 1024,
        });
        const out = (result.stdout ?? Buffer.alloc(0)).toString();
        if (out) diff += out;
      }
    }

    return { diff: diff || "(no changes)", commits: tip.commits };
  } catch {
    return { diff: "(failed to capture diff)", commits: 0 };
  }
}

function parseDiffStats(diff: string, commits: number): DiffStats {
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("diff --no-index")) filesChanged++;
    else if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
    else if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
  }

  return { filesChanged, linesAdded, linesRemoved, commits };
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

async function runArm(config: Config, condition: Condition, outDir: string): Promise<ArmResult> {
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
  const { path: wtPath, baseSha, branchesBefore } = createWorktree(config.repo, wtName, config.branch);
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

  const { diff, commits } = captureDiff(wtPath, baseSha);
  const diffStats = parseDiffStats(diff, commits);
  log(`[${condition}] Diff: ${diffStats.filesChanged} files, +${diffStats.linesAdded} -${diffStats.linesRemoved}${commits ? ` (${commits} commit${commits === 1 ? "" : "s"} made by agent)` : ""}`);

  const unblockedCalls = extractUnblockedCalls(runResult.toolCalls);
  if (unblockedCalls.length > 0) {
    log(`[${condition}] Unblocked calls: ${unblockedCalls.length}`);
  }

  const cost = runResult.totalCostUsd ?? estimateCost(config.model, runResult.tokenUsage);

  return { condition, run: { ...runResult, worktreePath: wtPath, branchesBefore }, diff, diffStats, unblockedCalls, estimatedCost: cost };
}

export async function run(config: Config): Promise<ComparisonResult> {
  const startTime = Date.now();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(process.cwd(), "results", `run-${timestamp}`);
  const baselineDir = path.join(outDir, "baseline");
  const unblockedDir = path.join(outDir, "unblocked");
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.mkdirSync(unblockedDir, { recursive: true });

  let baseline: ArmResult;
  let unblocked: ArmResult;

  try {
    [baseline, unblocked] = await Promise.all([
      runArm(config, "baseline", baselineDir),
      runArm(config, "unblocked", unblockedDir),
    ]);
  } finally {
    if (!config.keepWorktrees) {
      log("Cleaning up worktrees...");
      for (const arm of [baseline!, unblocked!]) {
        if (!arm) continue;
        removeWorktree(config.repo, path.basename(arm.run.worktreePath), arm.run.branchesBefore);
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
