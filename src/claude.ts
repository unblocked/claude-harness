import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Condition, RunResult, TokenUsage, ToolCall } from "./types.ts";
import { log } from "./util.ts";
import { git, tryGit } from "./git.ts";

const BINARY = process.env.CLAUDE_BINARY ?? "claude";

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  thinkingTokens?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

interface ParsedStream {
  tokenUsage: TokenUsage;
  toolCalls: ToolCall[];
  assistantTurns: number;
  finalResponse: string;
  sessionId?: string;
  totalCostUsd: number | null;
  cliDurationMs: number | null;
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
  // tool_use id -> the ToolCall awaiting its tool_result, so we can attribute wall time.
  const pending = new Map<string, ToolCall>();
  const messageIds = new Set<string>();
  let finalResponse = "";
  let sessionId: string | undefined;
  let totalCostUsd: number | null = null;
  let cliDurationMs: number | null = null;

  // Per-segment result state (see the result handling below).
  let segLast: Record<string, ModelUsage> | null = null;
  let segFallback: TokenUsage | null = null;
  let segUsage: TokenUsage | null = null;   // the last result's top-level usage: this process only
  let segCost: number | null = null;
  const addFallback = (acc: TokenUsage | null, u: Record<string, number>): TokenUsage => ({
    inputTokens: (acc?.inputTokens ?? 0) + (u.input_tokens ?? 0), outputTokens: (acc?.outputTokens ?? 0) + (u.output_tokens ?? 0),
    cacheReadTokens: (acc?.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0), cacheCreationTokens: (acc?.cacheCreationTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  });
  const flushSegment = () => {
    // A second resume of the same session has been seen to report modelUsage
    // and total_cost_usd that include the previous resumed process's usage,
    // while the top-level usage stays per process. When the two disagree by
    // more than a fifth, scale the per-model figures and the cost down to the
    // top-level usage.
    let scale = 1;
    if (segLast && segUsage) {
      const sum = (u: TokenUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
      const modelTotal = Object.values(segLast).reduce((a, mu) => a + (mu.inputTokens ?? 0) + (mu.outputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0), 0);
      const top = sum(segUsage);
      if (modelTotal > 0 && top > 0 && top / modelTotal < 0.8) {
        scale = top / modelTotal;
        log(`parse: modelUsage (${Math.round(modelTotal / 1000)}k tokens) exceeds this process's usage (${Math.round(top / 1000)}k); carried over from a resumed session, scaling cost and per-model tokens by ${scale.toFixed(2)}`);
      }
    }
    if (segLast) {
      const byModel: Record<string, TokenUsage> = usage.byModel ?? {};
      for (const [model, mu] of Object.entries(segLast)) {
        const m: TokenUsage = {
          inputTokens: Math.round((mu.inputTokens ?? 0) * scale),
          outputTokens: Math.round((mu.outputTokens ?? 0) * scale),
          cacheReadTokens: Math.round((mu.cacheReadInputTokens ?? 0) * scale),
          cacheCreationTokens: Math.round((mu.cacheCreationInputTokens ?? 0) * scale),
          ...(typeof mu.costUSD === "number" ? { costUsd: mu.costUSD * scale } : {}),
          ...(typeof mu.thinkingTokens === "number" ? { thinkingTokens: Math.round(mu.thinkingTokens * scale) } : {}),
        };
        const prev = byModel[model];
        byModel[model] = prev ? {
          inputTokens: prev.inputTokens + m.inputTokens, outputTokens: prev.outputTokens + m.outputTokens,
          cacheReadTokens: prev.cacheReadTokens + m.cacheReadTokens, cacheCreationTokens: prev.cacheCreationTokens + m.cacheCreationTokens,
          ...((prev.costUsd ?? m.costUsd) !== undefined ? { costUsd: (prev.costUsd ?? 0) + (m.costUsd ?? 0) } : {}),
          ...((prev.thinkingTokens ?? m.thinkingTokens) !== undefined ? { thinkingTokens: (prev.thinkingTokens ?? 0) + (m.thinkingTokens ?? 0) } : {}),
        } : m;
        usage.inputTokens += m.inputTokens;
        usage.outputTokens += m.outputTokens;
        usage.cacheReadTokens += m.cacheReadTokens;
        usage.cacheCreationTokens += m.cacheCreationTokens;
      }
      usage.byModel = byModel;
    } else if (segFallback) {
      // Transcripts without modelUsage: main model only.
      usage.inputTokens += segFallback.inputTokens;
      usage.outputTokens += segFallback.outputTokens;
      usage.cacheReadTokens += segFallback.cacheReadTokens;
      usage.cacheCreationTokens += segFallback.cacheCreationTokens;
    }
    if (segCost !== null) totalCostUsd = (totalCostUsd ?? 0) + segCost * scale;
    segLast = null; segFallback = null; segUsage = null; segCost = null;
  };

  for (const e of events) {
    const eventMs = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : NaN;

    if (e?.type === "system" && e?.subtype === "init") {
      sessionId = e.session_id;
    }

    // Tool results come back as user messages; close out the matching tool_use.
    if (e?.type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content as ContentBlock[]) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);
        if (!Number.isNaN(eventMs) && call.timestamp > 0) {
          call.durationMs = Math.max(0, eventMs - call.timestamp);
        }
      }
    }

    if (e?.type === "assistant") {
      const nested = typeof e.parent_tool_use_id === "string";
      if (!nested) messageIds.add(String(e.message?.id ?? `evt-${messageIds.size}`));
      const content: ContentBlock[] = e.message?.content ?? [];
      for (const block of content) {
        // The final response is the main thread's last text; a sub-agent's
        // text must not replace it. The result event's own text wins below.
        if (!nested && block.type === "text" && typeof block.text === "string") {
          finalResponse = block.text;
        }
        if (block.type === "tool_use" && block.name) {
          const { isMcp, mcpServer } = parseToolName(block.name);
          const call: ToolCall = {
            name: block.name,
            args: block.input ?? {},
            timestamp: Number.isNaN(eventMs) ? 0 : eventMs,
            isMcp,
            mcpServer,
            model: typeof e.message?.model === "string" ? e.message.model : undefined,
            nested: typeof e.parent_tool_use_id === "string" ? true : undefined,
          };
          toolCalls.push(call);
          if (block.id) pending.set(block.id, call);
        }
      }
      if (e.session_id) sessionId = e.session_id;
    }

    // Result events. One CLI process can emit several (a resumed session
    // first flushes pending task notifications as an empty turn, and each
    // wake-up ends in its own result); within a process total_cost_usd and
    // modelUsage are cumulative, duration_ms and usage are per turn. A
    // transcript may also concatenate several processes (draft pass, fix
    // passes), separated by harness session_start markers. So: the last
    // result in each segment carries that segment's cost and usage; segments
    // are summed.
    if (e?.type === "harness" && e?.subtype === "session_start") {
      flushSegment();
      continue;
    }
    if (e?.type === "result") {
      if (typeof e.result === "string" && e.result.trim()) finalResponse = e.result;
      if (e.modelUsage && typeof e.modelUsage === "object") segLast = e.modelUsage as Record<string, ModelUsage>;
      else if (e.usage) segFallback = addFallback(segFallback, e.usage);
      if (e.usage) segUsage = addFallback(segUsage, e.usage);
      if (typeof e.total_cost_usd === "number") segCost = e.total_cost_usd;
      if (typeof e.duration_ms === "number") cliDurationMs = (cliDurationMs ?? 0) + e.duration_ms;
      if (e.session_id) sessionId = e.session_id;
    }
  }
  flushSegment();

  return { tokenUsage: usage, toolCalls, assistantTurns: messageIds.size, finalResponse, sessionId, totalCostUsd, cliDurationMs };
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

export function createWorktree(repoPath: string, name: string, branch: string): { path: string; baseSha: string } {
  const wtPath = worktreePath(repoPath, name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(repoPath, ["worktree", "add", "--detach", wtPath, branch]);
  // `worktree add` leaves submodules empty; an agent then loses minutes to a
  // missing schema or vendored dependency before it can even compile.
  if (fs.existsSync(path.join(wtPath, ".gitmodules"))) {
    if (tryGit(wtPath, ["submodule", "update", "--init", "--recursive"], "initialising submodules in worktree") !== null) log(`Initialised submodules in ${name}`);
  }
  const baseSha = git(wtPath, ["rev-parse", "HEAD"]).trim();
  return { path: wtPath, baseSha };
}

// Removes the worktree and undoes what the agent did to the repo's refs, using
// the set of commits the agent made (see runner.ts agentCommits):
//   - a branch that did not exist at run start and whose tip is an agent commit
//     is deleted: the agent created it and it holds only the agent's work;
//   - a branch that did exist and now points at an agent commit was moved by
//     the agent (it checked it out and committed): it is reset to its pre-run
//     sha, and the agent's tip is logged so it can be recovered;
//   - anything else is left alone, including a branch the user created mid-run
//     that the agent merely checked out.
// Runs after the diff is captured. Not called under --keep-worktrees.
export function removeWorktree(repoPath: string, name: string, refsBefore: Map<string, string> | null, agentCommits: Set<string>): void {
  const wtPath = worktreePath(repoPath, name);
  if (tryGit(repoPath, ["worktree", "remove", "--force", wtPath], `removing worktree ${name}`) === null) {
    tryGit(repoPath, ["worktree", "prune"], "pruning worktrees");
  }
  if (!refsBefore) { log(`Skipping branch cleanup for ${name}: no ref snapshot from run start`); return; }
  if (agentCommits.size === 0) return;

  const now = tryGit(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"], "listing branches after run") ?? "";
  for (const line of now.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const sha = line.slice(0, sp), ref = line.slice(sp + 1), short = ref.replace(/^refs\/heads\//, "");
    if (!agentCommits.has(sha)) continue;
    const before = refsBefore.get(ref);
    if (before === undefined) {
      if (tryGit(repoPath, ["branch", "-D", short], `deleting agent-created branch ${short}`) !== null) log(`Deleted agent-created branch ${short} (was ${sha.slice(0, 7)})`);
    } else if (before !== sha) {
      if (tryGit(repoPath, ["update-ref", ref, before, sha], `resetting ${short} to its pre-run sha`) !== null) {
        log(`Agent moved pre-existing branch ${short} to ${sha.slice(0, 7)}; reset to ${before.slice(0, 7)}. The agent's commit is still reachable by sha for a while.`);
      }
    }
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
  // Continue an earlier session in the same worktree (the review fix pass).
  resumeSessionId?: string;
  // Transcript file name; defaults to <condition>.jsonl.
  jsonlName?: string;
}): Promise<RunResult> {
  const jsonlPath = path.join(opts.outDir, opts.jsonlName ?? `${opts.condition}.jsonl`);

  // The prompt goes in argv, not stdin: the CLI gives up on stdin after 3s,
  // and a synchronous step elsewhere in the harness (the other arm's worktree
  // setup) can hold the event loop longer than that before the pipe flushes.
  const args = [
    "-p", opts.prompt,
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    "--output-format", "stream-json",
    "--verbose",
    // message_delta events carry each API message's exact output token count
    // (thinking included); without them per-message output is an estimate.
    "--include-partial-messages",
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

    p.stdin.end();

    const out = fs.createWriteStream(jsonlPath);
    // Harness marker: when this session started, so a transcript assembled from
    // a draft pass and a resumed fix pass shows where agent time resumes.
    out.write(JSON.stringify({ type: "harness", subtype: "session_start", timestamp: new Date().toISOString(), condition: opts.condition, resume: !!opts.resumeSessionId }) + "\n");
    let partial = "";
    let toolCount = 0;
    let editCount = 0;
    let turnCount = 0;
    const tag = opts.condition;
    let killed = false;

    let unblockedCallSeen = false;

    const unblockedDeadline = opts.condition === "unblocked" && !opts.resumeSessionId
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

  const wallMs = Date.now() - started;
  return {
    durationMs: parsed.cliDurationMs ?? wallMs,
    wallMs,
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
