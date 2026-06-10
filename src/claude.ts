import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Condition, RunResult, TokenUsage, ToolCall } from "./types.ts";
import { log } from "./util.ts";

const BINARY = process.env.CLAUDE_BINARY ?? "claude";

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ParsedStream {
  tokenUsage: TokenUsage;
  toolCalls: ToolCall[];
  assistantTurns: number;
  finalResponse: string;
  sessionId?: string;
  totalCostUsd: number | null;
}

function parseToolName(name: string): { isMcp: boolean; mcpServer?: string } {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { isMcp: true, mcpServer: parts[1] };
  }
  if (name.includes("::")) {
    return { isMcp: true, mcpServer: name.split("::")[0] };
  }
  return { isMcp: false };
}

export function parseStreamJson(jsonl: string): ParsedStream {
  const events = jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e !== null);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const toolCalls: ToolCall[] = [];
  let assistantTurns = 0;
  let finalResponse = "";
  let sessionId: string | undefined;
  let totalCostUsd: number | null = null;

  for (const e of events) {
    if (e?.type === "system" && e?.subtype === "init") {
      sessionId = e.session_id;
    }

    if (e?.type === "assistant") {
      assistantTurns++;
      const content: ContentBlock[] = e.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          finalResponse = block.text;
        }
        if (block.type === "tool_use" && block.name) {
          const { isMcp, mcpServer } = parseToolName(block.name);
          toolCalls.push({
            name: block.name,
            args: block.input ?? {},
            timestamp: 0,
            isMcp,
            mcpServer,
            model: typeof e.message?.model === "string" ? e.message.model : undefined,
          });
        }
      }
      if (e.session_id) sessionId = e.session_id;
    }

    if (e?.type === "result") {
      if (e.modelUsage && typeof e.modelUsage === "object") {
        const byModel: Record<string, TokenUsage> = {};
        for (const [model, mu] of Object.entries(e.modelUsage as Record<string, ModelUsage>)) {
          const m: TokenUsage = {
            inputTokens: mu.inputTokens ?? 0,
            outputTokens: mu.outputTokens ?? 0,
            cacheReadTokens: mu.cacheReadInputTokens ?? 0,
            cacheCreationTokens: mu.cacheCreationInputTokens ?? 0,
          };
          byModel[model] = m;
          usage.inputTokens += m.inputTokens;
          usage.outputTokens += m.outputTokens;
          usage.cacheReadTokens += m.cacheReadTokens;
          usage.cacheCreationTokens += m.cacheCreationTokens;
        }
        usage.byModel = byModel;
      } else if (e.usage) {
        // Fallback for transcripts without modelUsage: main model only.
        usage.inputTokens = e.usage.input_tokens ?? 0;
        usage.outputTokens = e.usage.output_tokens ?? 0;
        usage.cacheReadTokens = e.usage.cache_read_input_tokens ?? 0;
        usage.cacheCreationTokens = e.usage.cache_creation_input_tokens ?? 0;
      }
      if (typeof e.total_cost_usd === "number") {
        totalCostUsd = e.total_cost_usd;
      }
      if (e.session_id) sessionId = e.session_id;
    }
  }

  return { tokenUsage: usage, toolCalls, assistantTurns, finalResponse, sessionId, totalCostUsd };
}

function isUnblockedTool(name: string): boolean {
  return name.toLowerCase().includes("unblocked");
}

function isUnblockedCliCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== "Bash") return false;
  const cmd = (args.command as string) ?? "";
  return /^unblocked\s+context[_-]/.test(cmd);
}

const WORKTREE_BASE = path.join(os.tmpdir(), "claude-harness-wt");

export function worktreePath(repoPath: string, name: string): string {
  const repoName = path.basename(repoPath);
  return path.join(WORKTREE_BASE, repoName, name);
}

export function createWorktree(repoPath: string, name: string, branch: string): string {
  const wtPath = worktreePath(repoPath, name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  execSync(`git worktree add --detach "${wtPath}" "${branch}"`, { cwd: repoPath, stdio: "pipe" });
  return wtPath;
}

export function removeWorktree(repoPath: string, name: string): void {
  const wtPath = worktreePath(repoPath, name);
  try {
    execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoPath, stdio: "pipe" });
  } catch {
    try { execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" }); } catch {}
  }
}

const UNBLOCKED_MCP_TOOLS = [
  "mcp__unblocked__context_research",
  "mcp__unblocked__context_get_urls",
  "mcp__unblocked__context_get_rules",
  "mcp__unblocked__submit_feedback",
];

export async function runClaude(opts: {
  prompt: string;
  worktreePath: string;
  model: string;
  condition: Condition;
  timeoutMs: number;
  outDir: string;
  blockUnblocked: boolean;
}): Promise<RunResult> {
  const jsonlPath = path.join(opts.outDir, `${opts.condition}.jsonl`);

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model", opts.model,
  ];

  if (opts.blockUnblocked) {
    for (const tool of UNBLOCKED_MCP_TOOLS) {
      args.push("--disallowed-tools", tool);
    }
    args.push("--disallowed-tools", "Bash(unblocked *)");
  }

  const started = Date.now();

  const result = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    const p = spawn(BINARY, args, {
      cwd: opts.worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    p.stdin.end(opts.prompt);

    const out = fs.createWriteStream(jsonlPath);
    let partial = "";
    let toolCount = 0;
    let editCount = 0;
    let turnCount = 0;
    const tag = opts.condition;
    let killed = false;

    let unblockedCallSeen = false;

    const unblockedDeadline = opts.condition === "unblocked"
      ? setTimeout(() => {
          if (!unblockedCallSeen && !killed) {
            log(`[${tag}] ⛔ Unblocked not called within 120s — killing run`);
            killed = true;
            p.kill("SIGTERM");
            setTimeout(() => p.kill("SIGKILL"), 5_000);
          }
        }, 120_000)
      : null;

    p.stdout.on("data", (chunk: Buffer) => {
      out.write(chunk);
      partial += chunk.toString();
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);

          if (e?.type === "assistant") {
            turnCount++;
            const content: ContentBlock[] = e.message?.content ?? [];
            let text = "";
            for (const block of content) {
              if (block.type === "text" && block.text) {
                text += block.text;
              }
              if (block.type === "tool_use" && block.name) {
                toolCount++;
                const toolName = block.name;
                const input = block.input ?? {};
                let label = "";

                if (toolName === "Bash") {
                  const cmd = (input.command as string) ?? "";
                  label = `Bash: ${cmd.slice(0, 100)}`;
                } else if (toolName === "Edit") {
                  editCount++;
                  const fp = (input.file_path as string) ?? "";
                  label = `✏️  Edit #${editCount}: ...${fp.slice(-60)}`;
                } else if (toolName === "Read") {
                  const fp = (input.file_path as string) ?? "";
                  label = `Read: ...${fp.slice(-60)}`;
                } else if (toolName === "Write") {
                  const fp = (input.file_path as string) ?? "";
                  label = `Write: ...${fp.slice(-60)}`;
                } else if (toolName === "Skill") {
                  const skill = (input.skill as string) ?? (input.name as string) ?? "";
                  label = `Skill: ${skill}`;
                } else {
                  const { isMcp, mcpServer } = parseToolName(toolName);
                  if (isMcp) {
                    const query = (input.query as string) ?? (input.url as string) ?? "";
                    label = `MCP:${mcpServer}/${toolName.split(/__|::/).pop()} ${query ? `"${query.slice(0, 80)}"` : ""}`;
                  } else {
                    label = toolName;
                  }
                }
                if (label) log(`[${tag}]   #${toolCount} ${label}`);

                const isUbMcp = isUnblockedTool(toolName);
                const isUbCli = isUnblockedCliCall(toolName, input);

                if (opts.condition === "baseline" && !killed && (isUbMcp || isUbCli)) {
                  log(`[${tag}] ⛔ CONTAMINATION: baseline called Unblocked — killing run`);
                  killed = true;
                  p.kill("SIGTERM");
                  setTimeout(() => p.kill("SIGKILL"), 5_000);
                }

                if (opts.condition === "unblocked" && !unblockedCallSeen && (isUbMcp || isUbCli)) {
                  unblockedCallSeen = true;
                  if (unblockedDeadline) clearTimeout(unblockedDeadline);
                  log(`[${tag}] ✅ Unblocked call detected`);
                }
              }
            }
            if (text) {
              log(`[${tag}] 🗣️  Turn ${turnCount}: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
            }
          } else if (e?.type === "result") {
            const dur = e.duration_ms ? `${Math.round(e.duration_ms / 1000)}s` : "";
            const cost = e.total_cost_usd ? `$${e.total_cost_usd.toFixed(4)}` : "";
            log(`[${tag}] 📊 Result: ${e.num_turns ?? "?"} turns, ${dur}, ${cost}`);
          }
        } catch {}
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 5_000);
    }, opts.timeoutMs);

    p.stderr.on("data", (d: Buffer) => process.stderr.write(`[claude:${opts.condition}] ${d}`));

    p.on("close", (code) => {
      clearTimeout(timer);
      if (unblockedDeadline) clearTimeout(unblockedDeadline);
      out.end();
      resolve({ exitCode: code, timedOut });
    });

    p.on("error", reject);
  });

  const jsonl = fs.readFileSync(jsonlPath, "utf8");
  const parsed = parseStreamJson(jsonl);

  return {
    durationMs: Date.now() - started,
    tokenUsage: parsed.tokenUsage,
    toolCalls: parsed.toolCalls,
    assistantTurns: parsed.assistantTurns,
    finalResponse: parsed.finalResponse,
    sessionId: parsed.sessionId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    jsonlPath,
    worktreePath: opts.worktreePath,
    totalCostUsd: parsed.totalCostUsd,
  };
}
