import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { Condition, RunResult, TokenUsage, ToolCall } from "./types.ts";
import { log } from "./util.ts";

const BINARY = process.env.CLAUDE_BINARY ?? "claude";

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
  // mcp__server__tool format
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { isMcp: true, mcpServer: parts[1] };
  }
  // server::tool format
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
          });
        }
      }
      if (e.session_id) sessionId = e.session_id;
    }

    if (e?.type === "result") {
      if (e.usage) {
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
  const lower = name.toLowerCase();
  return lower.includes("unblocked");
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

function findUnblockedBinary(): string {
  try {
    return execSync("which unblocked", { stdio: "pipe" }).toString().trim();
  } catch {
    const defaultPath = path.join(os.homedir(), ".unblocked", "bin", "unblocked");
    if (fs.existsSync(defaultPath)) return defaultPath;
    return "unblocked";
  }
}

export function buildMcpConfig(): string {
  const unblockedBin = findUnblockedBinary();
  const config = {
    mcpServers: {
      unblocked: {
        command: unblockedBin,
        args: ["--mcp", "--autoupdate", "--client", "mcpClaudeCode"],
      },
    },
  };
  const tmpPath = path.join(os.tmpdir(), `claude-harness-mcp-${randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(config));
  return tmpPath;
}

export async function runClaude(opts: {
  prompt: string;
  repoPath: string;
  model: string;
  branch: string;
  condition: Condition;
  timeoutMs: number;
  outDir: string;
  mcpConfigPath?: string;
}): Promise<RunResult> {
  const suffix = randomBytes(4).toString("hex");
  const wtName = `${opts.condition}-${suffix}`;
  const jsonlPath = path.join(opts.outDir, `${opts.condition}.jsonl`);

  log(`[${opts.condition}] Creating worktree: ${wtName}`);
  const wtPath = createWorktree(opts.repoPath, wtName, opts.branch);
  log(`[${opts.condition}] Worktree at: ${wtPath}`);

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model", opts.model,
    "--disable-slash-commands",
  ];

  if (opts.mcpConfigPath) {
    args.push("--strict-mcp-config", "--mcp-config", opts.mcpConfigPath);
  } else {
    args.push("--strict-mcp-config");
  }

  args.push(opts.prompt);

  const started = Date.now();

  const result = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    const p = spawn(BINARY, args, {
      cwd: wtPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
            log(`[${tag}] ⛔ Unblocked not called within 60s — killing run`);
            killed = true;
            p.kill("SIGTERM");
            setTimeout(() => p.kill("SIGKILL"), 5_000);
          }
        }, 60_000)
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
    worktreePath: wtPath,
    totalCostUsd: parsed.totalCostUsd,
  };
}
