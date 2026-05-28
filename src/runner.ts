import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Condition, Config, DiffStats, UnblockedCall } from "./types.ts";
import { runClaude, createWorktree, removeWorktree } from "./claude.ts";
import { printReport, writeJsonResult, writeHtmlReport } from "./report.ts";
import { estimateCost, formatCost, formatDuration, log } from "./util.ts";

function captureDiff(cwd: string): string {
  try {
    const staged = execSync("git diff --staged", { cwd, stdio: "pipe", maxBuffer: 2 * 1024 * 1024 }).toString();
    const unstaged = execSync("git diff", { cwd, stdio: "pipe", maxBuffer: 2 * 1024 * 1024 }).toString();
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd, stdio: "pipe" }).toString().trim();

    let diff = staged + unstaged;

    if (untracked) {
      for (const file of untracked.split("\n").filter(Boolean)) {
        const result = spawnSync("git", ["diff", "--no-index", "/dev/null", file], {
          cwd, stdio: "pipe", maxBuffer: 1024 * 1024,
        });
        const out = (result.stdout ?? Buffer.alloc(0)).toString();
        if (out) diff += out;
      }
    }

    return diff || "(no changes)";
  } catch {
    return "(failed to capture diff)";
  }
}

function parseDiffStats(diff: string): DiffStats {
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("diff --no-index")) filesChanged++;
    else if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
    else if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
  }

  return { filesChanged, linesAdded, linesRemoved };
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

const BASELINE_NUDGE = `IMPORTANT: Do NOT use any Unblocked tools, skills, or CLI commands. Do NOT call context_research, context_get_urls, or any tool with "unblocked" in its name. Do NOT run the "unblocked" CLI binary. You may use all other tools, MCP servers, plugins, and skills.

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
  const wtPath = createWorktree(config.repo, wtName, config.branch);
  log(`[${condition}] Worktree at: ${wtPath}`);

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

  const diff = captureDiff(wtPath);
  const diffStats = parseDiffStats(diff);
  log(`[${condition}] Diff: ${diffStats.filesChanged} files, +${diffStats.linesAdded} -${diffStats.linesRemoved}`);

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
      if (baseline!) {
        const wtName = path.basename(baseline.run.worktreePath);
        removeWorktree(config.repo, wtName);
      }
      if (unblocked!) {
        const wtName = path.basename(unblocked.run.worktreePath);
        removeWorktree(config.repo, wtName);
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
