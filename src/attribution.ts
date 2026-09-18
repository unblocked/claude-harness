import fs from "node:fs";
import type { AttributedTurn, Attribution, AttributionTotals, TurnLabel } from "./types.ts";
import { costAt, formatCost, formatDuration, log, priceFor } from "./util.ts";
import { runStructured, VERIFY_CMD } from "./analyst.ts";

// Per-message attribution: an analyst model labels every assistant message as
// task work, verification, or housekeeping, so the comparison can be reported
// with and without the tail of tidying, committing and redundant reruns that
// both agents tend to add after the task is done. Housekeeping is model habit,
// not something the treatment caused, and it swings small deltas.

interface WalkTool { name: string; args: string; result: string }
export interface WalkTurn {
  turn: number;
  text: string;
  tools: WalkTool[];
  startMs: number;
  costUsd: number;
  durationMs: number;
  modelMs: number;
  toolMs: number;
  outputTokens: number;
  outputExact: boolean;
  cacheReadTokens: number;
}


function excerpt(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function argsExcerpt(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return "`" + excerpt(String(input.command ?? ""), 220) + "`";
  if (name === "Edit") return `${String(input.file_path ?? "").split("/").slice(-3).join("/")}: "${excerpt(String(input.old_string ?? ""), 60)}" -> "${excerpt(String(input.new_string ?? ""), 60)}"`;
  if (name === "Write") return `${String(input.file_path ?? "").split("/").slice(-3).join("/")} (${String(input.content ?? "").length} chars)`;
  if (name === "Read") return String(input.file_path ?? "").split("/").slice(-3).join("/");
  const q = input.query ?? input.url ?? input.urls ?? input.pattern;
  return q ? excerpt(String(q), 160) : excerpt(JSON.stringify(input), 160);
}

function resultExcerpt(name: string, args: string, body: string): string {
  // Test and CI output: the verdict is at the end. Everything else: the start is enough.
  if (name === "Bash" && VERIFY_CMD.test(args)) return "…" + excerpt(body.slice(-600), 600);
  return excerpt(body, 300);
}

const tsOf = (e: { timestamp?: unknown }): number => typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;

// One row per API message.
//
// Timing. Content blocks stream as they complete, so a message's first block
// arrives after its generation; its tools run after its last block; the next
// message's generation starts when the last tool result comes back. So each
// message owns the window from the previous message's end to its own end:
//   modelMs = last block − previous end     (thinking + generation)
//   toolMs  = last tool result − last block (waiting on tools)
// Tokens. Every block of a message carries the same usage snapshot; its cache
// counts are exact, its output_tokens is the message-start value. When the run
// was recorded with --include-partial-messages the stream's message_delta has
// the exact output count (thinking included) and is used. Otherwise the run's
// real output total is shared across messages by content size, and the row is
// marked outputExact=false. Per-message cost is priced from those numbers and
// scaled so the messages sum to the billed total.
export function buildWalk(jsonl: string, totalCostUsd: number | null): WalkTurn[] {
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  interface Row extends WalkTurn { id: string; rawCost: number; chars: number; thinkingEst: number; usage: Record<string, number>; cache1h: number; model: string; lastBlockMs: number; lastResultMs: number; segmentStartMs: number }
  const rows: Row[] = [];
  const byId = new Map<string, Row>();
  const pending = new Map<string, { tool: WalkTool; row: Row }>();
  const exactOutput = new Map<string, number>();
  let streamMsgId = "";
  let totalOutput = 0;
  let totalThinking = 0;
  let pendingThinking = 0;   // thinking_tokens deltas seen since the last message started
  let firstTs = NaN;
  let segmentStartMs = NaN;  // harness session_start marker; a second one is the resumed fix pass, and the gap before it (the review call) is not agent time

  for (const e of events) {
    const t = tsOf(e);
    if (!Number.isNaN(t) && Number.isNaN(firstTs)) firstTs = t;
    if (e.type === "result") {
      for (const mu of Object.values((e.modelUsage ?? {}) as Record<string, { outputTokens?: number; thinkingTokens?: number }>)) {
        totalOutput += mu.outputTokens ?? 0;
        totalThinking += mu.thinkingTokens ?? 0;
      }
      if (!totalOutput && e.usage?.output_tokens) totalOutput = e.usage.output_tokens;
      continue;
    }
    // The CLI's running estimate of thinking tokens, emitted while a message is being generated.
    if (e.type === "system" && e.subtype === "thinking_tokens") { pendingThinking += e.estimated_tokens_delta ?? 0; continue; }
    if (e.type === "harness" && e.subtype === "session_start" && !Number.isNaN(t)) { segmentStartMs = t; continue; }

    if (typeof e.parent_tool_use_id === "string") {
      // Subagent traffic: charge its usage to the main-thread message that issued the Agent call.
      if (e.type === "assistant") {
        const parent = pending.get(String(e.parent_tool_use_id))?.row;
        if (parent) {
          const u = e.message?.usage ?? {};
          const price = priceFor(typeof e.message?.model === "string" ? e.message.model : "opus");
          const oneH = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          // Each nested message repeats its usage per block too; count a nested message once.
          const key = `nested:${e.message?.id ?? ""}`;
          if (!byId.has(key)) {
            byId.set(key, parent);
            parent.cacheReadTokens += u.cache_read_input_tokens ?? 0;
            parent.rawCost += costAt(price, { inputTokens: u.input_tokens ?? 0, outputTokens: 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: (u.cache_creation_input_tokens ?? 0) - oneH }) + (oneH / 1_000_000) * price.cacheWrite1h;
          }
          for (const block of e.message?.content ?? []) {
            if (block.type === "text" && block.text) parent.chars += block.text.length;
            if (block.type === "tool_use") parent.chars += JSON.stringify(block.input ?? {}).length;
          }
        }
      }
      continue;
    }

    if (e.type === "stream_event") {
      const ev = e.event ?? {};
      if (ev.type === "message_start" && ev.message?.id) streamMsgId = String(ev.message.id);
      if (ev.type === "message_delta" && streamMsgId && typeof ev.usage?.output_tokens === "number") exactOutput.set(streamMsgId, ev.usage.output_tokens);
      continue;
    }

    if (e.type === "assistant") {
      const id = String(e.message?.id ?? `evt-${rows.length}`);
      let row = byId.get(id);
      if (!row) {
        const u = e.message?.usage ?? {};
        row = {
          id, turn: rows.length + 1, text: "", tools: [], startMs: 0, costUsd: 0, durationMs: 0, modelMs: 0, toolMs: 0,
          outputTokens: 0, outputExact: false, cacheReadTokens: u.cache_read_input_tokens ?? 0,
          rawCost: 0, chars: 0, thinkingEst: pendingThinking, usage: u, cache1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          model: typeof e.message?.model === "string" ? e.message.model : "opus",
          lastBlockMs: NaN, lastResultMs: NaN, segmentStartMs,
        };
        pendingThinking = 0;
        rows.push(row); byId.set(id, row);
      }
      if (!Number.isNaN(t)) row.lastBlockMs = Number.isNaN(row.lastBlockMs) ? t : Math.max(row.lastBlockMs, t);
      for (const block of e.message?.content ?? []) {
        if (block.type === "thinking") row.chars += String(block.thinking ?? "").length;
        if (block.type === "text" && block.text) { row.text += excerpt(block.text, 200) + " "; row.chars += block.text.length; }
        if (block.type === "tool_use" && block.name) {
          row.chars += JSON.stringify(block.input ?? {}).length;
          const tool: WalkTool = { name: block.name, args: argsExcerpt(block.name, block.input ?? {}), result: "" };
          row.tools.push(tool);
          if (block.id) pending.set(block.id, { tool, row });
        }
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type !== "tool_result") continue;
        const p = pending.get(block.tool_use_id);
        if (!p) continue;
        pending.delete(block.tool_use_id);
        if (!Number.isNaN(t)) p.row.lastResultMs = Number.isNaN(p.row.lastResultMs) ? t : Math.max(p.row.lastResultMs, t);
        const body = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(block.content ?? "");
        p.tool.result = (block.is_error ? "[ERROR] " : "") + resultExcerpt(p.tool.name, p.tool.args, body);
      }
    }
  }

  // Windows: each message runs from the previous message's end to its own end.
  let prevEnd = firstTs;
  for (const r of rows) {
    if (!Number.isNaN(r.segmentStartMs) && r.segmentStartMs > prevEnd) prevEnd = r.segmentStartMs; // gap between sessions (the review call) is not agent time
    const end = Number.isNaN(r.lastResultMs) ? r.lastBlockMs : Math.max(r.lastBlockMs, r.lastResultMs);
    if (!Number.isNaN(prevEnd) && !Number.isNaN(end)) {
      r.startMs = prevEnd;
      r.modelMs = Math.max(0, r.lastBlockMs - prevEnd);
      r.toolMs = Math.max(0, end - r.lastBlockMs);
      r.durationMs = r.modelMs + r.toolMs;
      prevEnd = end;
    }
  }

  // Output tokens: exact where the stream had message_delta. Otherwise the
  // run's thinking total is shared by each message's thinking_tokens deltas and
  // the visible remainder by content size.
  let exactSum = 0, inexactChars = 0, inexactThinking = 0;
  for (const r of rows) {
    if (exactOutput.has(r.id)) { r.outputTokens = exactOutput.get(r.id)!; r.outputExact = true; exactSum += r.outputTokens; }
    else { inexactChars += r.chars; inexactThinking += r.thinkingEst; }
  }
  const remaining = Math.max(0, totalOutput - exactSum);
  const thinkingShare = Math.min(remaining, totalThinking);
  const visibleShare = remaining - thinkingShare;
  for (const r of rows) {
    if (r.outputExact) continue;
    const think = inexactThinking > 0 ? thinkingShare * (r.thinkingEst / inexactThinking) : 0;
    const vis = inexactChars > 0 ? visibleShare * (r.chars / inexactChars) : 0;
    r.outputTokens = Math.round(think + vis);
  }

  for (const r of rows) {
    r.text = r.text.trim();
    const price = priceFor(r.model);
    r.rawCost += costAt(price, {
      inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.outputTokens,
      cacheReadTokens: r.usage.cache_read_input_tokens ?? 0, cacheCreationTokens: (r.usage.cache_creation_input_tokens ?? 0) - r.cache1h,
    }) + (r.cache1h / 1_000_000) * price.cacheWrite1h;
  }
  const rawSum = rows.reduce((a, r) => a + r.rawCost, 0);
  const scale = totalCostUsd && rawSum > 0 ? totalCostUsd / rawSum : 1;
  for (const r of rows) r.costUsd = r.rawCost * scale;
  return rows.map(({ id: _id, rawCost: _rc, chars: _c, thinkingEst: _te, usage: _u, cache1h: _h, model: _m, lastBlockMs: _lb, lastResultMs: _lr, segmentStartMs: _ss, ...t }) => t);
}

function renderWalk(walk: WalkTurn[]): string {
  return walk.map(t => {
    const lines = [`Turn ${t.turn}${t.text ? ` — agent: "${t.text}"` : ""}`];
    for (const tool of t.tools) lines.push(`  ${tool.name} ${tool.args}${tool.result ? `\n    -> ${tool.result}` : ""}`);
    if (t.tools.length === 0 && !t.text) lines.push("  (thinking only)");
    return lines.join("\n");
  }).join("\n");
}

const SCHEMA = {
  type: "object",
  properties: {
    turns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          turn: { type: "integer" },
          label: { type: "string", enum: ["work", "verify", "housekeeping"] },
          repeat_of: { type: ["integer", "null"] },
          reason: { type: "string" },
        },
        required: ["turn", "label", "repeat_of", "reason"],
      },
    },
  },
  required: ["turns"],
};

export function analystPrompt(task: string, walk: WalkTurn[]): string {
  return `You are reviewing the transcript of an autonomous coding agent that was given a task. Label every turn so that task work can be measured separately from routine housekeeping. Both the agent's cost and its wall-clock time will be split by these labels, so be precise and consistent.

Labels:
- work: reading or searching code and docs, calling research tools, deciding, editing files, writing documentation, or writing the final summary. A turn that only narrates the next step is work.
- verify: running tests, linters, type checks, builds or CI to validate the change, and environment setup those runs need (starting a database or containers, preparing a test database). A re-run is verify only if the agent changed code since the previous run, or the previous run failed for a reason related to the change.
- housekeeping: activity that neither advances nor validates the task. Examples: reverting incidental changes to lockfiles or generated files; deleting build artifacts or temp files; git status, branch or log checks not needed to proceed; creating branches; committing; re-running a check that already passed with no code change in between; re-running after a failure unrelated to the change (a flaky test, infrastructure, a timeout).

Rules:
- Label every turn, in order, turn numbers exactly as given.
- A turn cannot be split. If it mixes purposes, label it by its dominant purpose. A turn that both commits and runs CI is housekeeping if the CI run is a repeat.
- Set repeat_of to the turn number this one redundantly repeats, otherwise null. A repeated verify run counts as housekeeping.
- The final summary turn (text only, no tool call, at the end) is work.
- reason: at most eight words, e.g. "reverts incidental lockfile change" or "commits checkpoint".

The task the agent was given:
"""
${task.slice(0, 2500)}
"""

Transcript (one entry per turn; "->" lines are tool results, truncated):
${renderWalk(walk)}
`;
}

type RawLabels = { turns: { turn: number; label: TurnLabel["label"]; repeat_of: number | null; reason: string }[] };

export function classifyTurns(walk: WalkTurn[], task: string, model: string): { labels: TurnLabel[]; analystCostUsd: number; modelUsed: string } | null {
  const res = runStructured<RawLabels>("Attribution", analystPrompt(task, walk), model, SCHEMA, 10 * 60 * 1000);
  if (!res) return null;
  const labels: TurnLabel[] = res.data.turns.map(t => ({ turn: t.turn, label: t.label, repeatOf: t.repeat_of ?? null, reason: t.reason }));
  return { labels, analystCostUsd: res.costUsd, modelUsed: res.modelUsed };
}

function totals(rows: AttributedTurn[]): AttributionTotals {
  const sum = (f: (r: AttributedTurn) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    costUsd: sum(r => r.costUsd), durationMs: sum(r => r.durationMs), modelMs: sum(r => r.modelMs), toolMs: sum(r => r.toolMs),
    turns: rows.length, outputTokens: sum(r => r.outputTokens), cacheReadTokens: sum(r => r.cacheReadTokens),
  };
}

export function rollup(walk: WalkTurn[], labels: TurnLabel[], analystModel: string, analystCostUsd: number): Attribution {
  const byTurn = new Map(labels.map(l => [l.turn, l]));
  const rows: AttributedTurn[] = walk.map(t => {
    const l = byTurn.get(t.turn) ?? { turn: t.turn, label: "work" as const, repeatOf: null, reason: "(unlabelled by analyst; counted as work)" };
    const summary = t.tools.length ? t.tools.map(x => `${x.name} ${x.args}`).join("; ").slice(0, 160) : (t.text.slice(0, 160) || "(thinking only)");
    return { ...l, startMs: t.startMs, costUsd: t.costUsd, durationMs: t.durationMs, modelMs: t.modelMs, toolMs: t.toolMs, outputTokens: t.outputTokens, cacheReadTokens: t.cacheReadTokens, summary };
  });
  const housekeeping = rows.filter(r => r.label === "housekeeping");
  const core = rows.filter(r => r.label !== "housekeeping");
  return {
    analystModel, analystCostUsd, outputExact: walk.length > 0 && walk.every(t => t.outputExact),
    raw: totals(rows), core: totals(core), housekeeping: totals(housekeeping), turns: rows,
  };
}

export function attribute(jsonlPath: string, task: string, totalCostUsd: number | null, model: string, tag: string): Attribution | null {
  const walk = buildWalk(fs.readFileSync(jsonlPath, "utf8"), totalCostUsd);
  if (walk.length === 0) { log(`[${tag}] Attribution: no messages in transcript`); return null; }
  log(`[${tag}] Attribution: labelling ${walk.length} messages with ${model}…`);
  const res = classifyTurns(walk, task, model);
  if (!res) return null;
  const a = rollup(walk, res.labels, res.modelUsed, res.analystCostUsd);
  log(`[${tag}] Attribution: core ${formatCost(a.core.costUsd)} / ${formatDuration(a.core.durationMs)} (${a.core.turns} msgs); housekeeping ${formatCost(a.housekeeping.costUsd)} / ${formatDuration(a.housekeeping.durationMs)} (${a.housekeeping.turns} msgs); analyst ${formatCost(res.analystCostUsd)} via ${res.modelUsed}${a.outputExact ? "" : "; per-message output estimated"}`);
  return a;
}
