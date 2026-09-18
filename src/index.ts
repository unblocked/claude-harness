#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { program } from "commander";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./types.ts";
import { run } from "./runner.ts";

function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, stdio: "pipe" }).toString().trim();
  } catch {
    return "HEAD";
  }
}

program
  .name("claude-harness")
  .description("A/B comparison: Claude Code agent with vs without Unblocked context")
  .requiredOption("--repo <path>", "Path to target git repository")
  .requiredOption("--task <string>", "Task description for the agent")
  .option("--model <model>", "Model for Claude to use", "opus")
  .option("--timeout <seconds>", "Max seconds per arm", "3600")
  .option("--branch <name>", "Branch to base worktree on (default: current HEAD)")
  .option("--keep-worktrees", "Don't clean up worktrees after run", false)
  .option("--cli", "Use Unblocked CLI via Bash tool instead of MCP", false)
  // opus by default: fable's input safeguards declined 6 of 7 first attempts on ordinary CI transcripts.
  .option("--analyst-model <model>", "Model that labels each message as work/verify/housekeeping", "opus")
  .option("--judge-model <model>", "Model for the quality judge and context-impact passes", "fable")
  .option("--no-attribution", "Skip the per-turn attribution pass")
  .option("--review", "One simulated review-and-fix round per arm before analysis (reviewer = judge model)", false);

program.parse();
const opts = program.opts();

const repoPath = path.resolve(opts.repo);
if (!fs.existsSync(repoPath)) {
  console.error(`Error: repo not found: ${repoPath}`);
  process.exit(1);
}

const config: Config = {
  repo: repoPath,
  task: opts.task,
  model: opts.model,
  timeoutSeconds: parseInt(opts.timeout),
  branch: opts.branch ?? getCurrentBranch(repoPath),
  keepWorktrees: opts.keepWorktrees,
  cliMode: opts.cli,
  analystModel: opts.attribution === false ? null : opts.analystModel,
  judgeModel: opts.judgeModel,
  review: opts.review,
};

run(config).catch((err) => {
  console.error("Run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
