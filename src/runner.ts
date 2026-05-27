import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Condition, Config, DiffStats, UnblockedCall } from "./types.ts";
import { runClaude, buildMcpConfig, removeWorktree, worktreePath } from "./claude.ts";
import { printReport, writeJsonResult, writeHtmlReport } from "./report.ts";
import { estimateCost, formatCost, formatDuration, log, totalTokens } from "./util.ts";

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

const BASELINE_NUDGE = `IMPORTANT: Do NOT use any Unblocked tools, skills, or CLI commands. Do NOT call context_research, context_get_urls, or any tool with "unblocked" in its name. Do NOT run the "unblocked" CLI binary. You may use all other tools.

TASK:
`;

const UNBLOCKED_MCP_NUDGE = `IMPORTANT: Before doing anything else, use the Unblocked MCP tools to gather context for this task.

1. FIRST, call the context_research MCP tool with a detailed query describing the task (effort: low)
2. If context_research surfaces specific URLs (PRs, docs, issues), call context_get_urls with those URLs
3. THEN use the gathered context to inform your implementation — follow the patterns, conventions, and approaches you discovered.

TASK:
`;

const UNBLOCKED_CLI_NUDGE = `IMPORTANT: Before doing anything else, use the Unblocked CLI to gather context for this task.

1. FIRST, run: unblocked context-research --effort low --query "<detailed query describing the task>"
2. If context-research surfaces specific URLs (PRs, docs, issues), run: unblocked context-get-urls --url "<url>"
3. THEN use the gathered context to inform your implementation — follow the patterns, conventions, and approaches you discovered.

TASK:
`;

async function runArm(config: Config, condition: Condition, outDir: string, mcpConfigPath?: string): Promise<ArmResult> {
  let nudge: string;
  if (condition === "baseline") {
    nudge = BASELINE_NUDGE;
  } else if (config.cliMode) {
    nudge = UNBLOCKED_CLI_NUDGE;
  } else {
    nudge = UNBLOCKED_MCP_NUDGE;
  }
  const prompt = nudge + config.task;

  log(`[${condition}] Running Claude Code...`);
  const runResult = await runClaude({
    prompt,
    repoPath: config.repo,
    model: config.model,
    branch: config.branch,
    condition,
    timeoutMs: config.timeoutSeconds * 1000,
    outDir,
    mcpConfigPath: condition === "unblocked" && !config.cliMode ? mcpConfigPath : undefined,
  });
  log(`[${condition}] Done: ${formatDuration(runResult.durationMs)}, ${runResult.assistantTurns} turns, exit=${runResult.exitCode}${runResult.timedOut ? " (TIMED OUT)" : ""}`);

  const diff = captureDiff(runResult.worktreePath);
  const diffStats = parseDiffStats(diff);
  log(`[${condition}] Diff: ${diffStats.filesChanged} files, +${diffStats.linesAdded} -${diffStats.linesRemoved}`);

  const unblockedCalls = extractUnblockedCalls(runResult.toolCalls);
  if (unblockedCalls.length > 0) {
    log(`[${condition}] Unblocked calls: ${unblockedCalls.length}`);
  }

  const cost = runResult.totalCostUsd ?? estimateCost(config.model, runResult.tokenUsage);

  return { condition, run: runResult, diff, diffStats, unblockedCalls, estimatedCost: cost };
}

export async function run(config: Config): Promise<ComparisonResult> {
  const startTime = Date.now();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(process.cwd(), "results", `run-${timestamp}`);
  const baselineDir = path.join(outDir, "baseline");
  const unblockedDir = path.join(outDir, "unblocked");
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.mkdirSync(unblockedDir, { recursive: true });

  let mcpConfigPath: string | undefined;
  if (!config.cliMode) {
    mcpConfigPath = buildMcpConfig();
    log(`MCP config written to: ${mcpConfigPath}`);
  }

  let baseline: ArmResult;
  let unblocked: ArmResult;

  try {
    baseline = await runArm(config, "baseline", baselineDir, mcpConfigPath);
    unblocked = await runArm(config, "unblocked", unblockedDir, mcpConfigPath);
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
    if (mcpConfigPath) {
      try { fs.unlinkSync(mcpConfigPath); } catch {}
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

  try { execSync(`open "${htmlPath}"`); } catch {}

  return result;
}
