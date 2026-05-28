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
  .option("--cli", "Use Unblocked CLI via Bash tool instead of MCP", false);

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
};

run(config).catch((err) => {
  console.error("Run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
