import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Attribution, AttributionTotals, TurnLabel } from "./types.ts";
import { costAt, formatCost, formatDuration, log, priceFor } from "./util.ts";

// Per-turn attribution: an analyst model labels every assistant turn as task
// work, verification, or housekeeping, so the comparison can be reported with
// and without the tail of tidying, committing and redundant reruns that both
// agents tend to add after the task is done. Housekeeping is model habit, not
// something the treatment caused, and it swings small deltas.

const BINARY = process.env.CLAUDE_BINARY ?? "claude";

interface WalkTool { name: string; args: string; result: string }
export interface WalkTurn {
  turn: number;
  text: string;
  tools: WalkTool[];
  costUsd: number;
  durationMs: number;
}

const VERIFY_CMD = /\b(rspec|bin\/ci|npm (test|run test)|go test|go vet|gofmt|rubocop|tsc|pytest|jest|make (test|check)|cargo test|mvn|gradle)\b/;

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

// One row per top-level assistant turn: what it said, what it ran, what came
// back, what it cost and how long until the next turn. Per-turn cost is priced
// from the turn's own usage and scaled so the turns sum to the run's billed
// total, which absorbs subagent usage and any pricing drift.
export function buildWalk(jsonl: string, totalCostUsd: number | null): WalkTurn[] {
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const turns: (WalkTurn & { ts: number; rawCost: number })[] = [];
  const pending = new Map<string, WalkTool>();
  let endTs = NaN;

  for (const e of events) {
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (e.type === "result" && !Number.isNaN(ts)) endTs = ts;
    if (typeof e.parent_tool_use_id === "string") continue; // subagent traffic: folded into the parent turn's cost via scaling

    if (e.type === "assistant") {
      const model = typeof e.message?.model === "string" ? e.message.model : "opus";
      const u = e.message?.usage ?? {};
      const rawCost = costAt(priceFor(model), {
        inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      });
      const turn: WalkTurn & { ts: number; rawCost: number } = { turn: turns.length + 1, text: "", tools: [], costUsd: 0, durationMs: 0, ts, rawCost };
      for (const block of e.message?.content ?? []) {
        if (block.type === "text" && block.text) turn.text += excerpt(block.text, 200) + " ";
        if (block.type === "tool_use" && block.name) {
          const tool: WalkTool = { name: block.name, args: argsExcerpt(block.name, block.input ?? {}), result: "" };
          turn.tools.push(tool);
          if (block.id) pending.set(block.id, tool);
        }
      }
      turn.text = turn.text.trim();
      turns.push(turn);
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type !== "tool_result") continue;
        const tool = pending.get(block.tool_use_id);
        if (!tool) continue;
        pending.delete(block.tool_use_id);
        const body = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(block.content ?? "");
        tool.result = (block.is_error ? "[ERROR] " : "") + resultExcerpt(tool.name, tool.args, body);
      }
    }
  }

  for (let i = 0; i < turns.length; i++) {
    const next = i + 1 < turns.length ? turns[i + 1].ts : endTs;
    turns[i].durationMs = !Number.isNaN(turns[i].ts) && !Number.isNaN(next) ? Math.max(0, next - turns[i].ts) : 0;
  }
  const rawSum = turns.reduce((a, t) => a + t.rawCost, 0);
  const scale = totalCostUsd && rawSum > 0 ? totalCostUsd / rawSum : 1;
  for (const t of turns) t.costUsd = t.rawCost * scale;
  return turns.map(({ ts: _ts, rawCost: _rc, ...t }) => t);
}

function renderWalk(walk: WalkTurn[]): string {
  return walk.map(t => {
    const lines = [`Turn ${t.turn}${t.text ? ` — agent: "${t.text}"` : ""}`];
    for (const tool of t.tools) lines.push(`  ${tool.name} ${tool.args}${tool.result ? `\n    -> ${tool.result}` : ""}`);
    if (t.tools.length === 0 && !t.text) lines.push("  (no content)");
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

// Strings that have tripped the analyst's input safeguards on real transcripts
// (auth headers, token env names, all-zero SHAs). None carry signal for labelling.
export function redact(s: string): string {
  return s
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b0{7,}\b/g, "<zero-sha>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(\w*(TOKEN|SECRET|PASSWORD|API_KEY)\w*)\b/g, "<credential-var>");
}

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
- Keep each reason to one short sentence naming what the turn did and why it got its label.

The task the agent was given:
"""
${task.slice(0, 2500)}
"""

Transcript (one entry per turn; "->" lines are tool results, truncated):
${redact(renderWalk(walk))}
`;
}

const FALLBACK_MODEL = "opus";

type AnalystOut = { structured_output?: { turns?: TurnLabel[] }; result?: string; total_cost_usd?: number; is_error?: boolean };

function callAnalyst(prompt: string, model: string): { out: AnalystOut | null; declined: boolean; error: string } {
  const args = [
    "-p", "--model", model, "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA),
  ];
  const res = spawnSync(BINARY, args, { input: prompt, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (!res.stdout?.length) return { out: null, declined: false, error: `exit ${res.status}: ${(res.stderr ?? "").toString().slice(0, 300)}` };
  let out: AnalystOut;
  try { out = JSON.parse(res.stdout.toString()); } catch (err) { return { out: null, declined: false, error: `unparseable output: ${(err as Error).message}` }; }
  if (out.structured_output?.turns) return { out, declined: false, error: "" };
  const msg = String(out.result ?? "");
  return { out, declined: /safeguards flagged/i.test(msg), error: msg.slice(0, 200) };
}

const DECLINE_RETRIES = 2;

// Labels every turn. The requested model's input safeguards sometimes decline
// an ordinary CI transcript and accept the identical prompt on the next try
// (observed with fable: declined, then passed 3/3), so a decline is retried
// before falling back to FALLBACK_MODEL. `analystModel` records what was used.
export function classifyTurns(walk: WalkTurn[], task: string, model: string): { labels: TurnLabel[]; analystCostUsd: number; modelUsed: string } | null {
  const prompt = analystPrompt(task, walk);
  let cost = 0;
  let modelUsed = model;
  let r = callAnalyst(prompt, model);
  cost += r.out?.total_cost_usd ?? 0;
  for (let attempt = 1; !r.out?.structured_output?.turns && r.declined && attempt <= DECLINE_RETRIES; attempt++) {
    log(`Attribution: ${model} declined the transcript (input safeguards, intermittent); retry ${attempt}/${DECLINE_RETRIES}`);
    r = callAnalyst(prompt, model);
    cost += r.out?.total_cost_usd ?? 0;
  }
  if (!r.out?.structured_output?.turns && r.declined && model !== FALLBACK_MODEL) {
    log(`Attribution: ${model} still declining; falling back to ${FALLBACK_MODEL}`);
    modelUsed = `${FALLBACK_MODEL} (${model} declined)`;
    r = callAnalyst(prompt, FALLBACK_MODEL);
    cost += r.out?.total_cost_usd ?? 0;
  }
  const raw = r.out?.structured_output?.turns;
  if (!raw) {
    log(`Attribution: analyst returned no labels: ${r.error}`);
    return null;
  }
  const labels: TurnLabel[] = raw.map(t => ({ turn: t.turn, label: t.label, repeatOf: (t as { repeat_of?: number | null }).repeat_of ?? t.repeatOf ?? null, reason: t.reason }));
  return { labels, analystCostUsd: cost, modelUsed };
}

function totals(rows: { costUsd: number; durationMs: number }[]): AttributionTotals {
  return { costUsd: rows.reduce((a, r) => a + r.costUsd, 0), durationMs: rows.reduce((a, r) => a + r.durationMs, 0), turns: rows.length };
}

export function rollup(walk: WalkTurn[], labels: TurnLabel[], analystModel: string, analystCostUsd: number): Attribution {
  const byTurn = new Map(labels.map(l => [l.turn, l]));
  const rows = walk.map(t => {
    const l = byTurn.get(t.turn) ?? { turn: t.turn, label: "work" as const, repeatOf: null, reason: "(unlabelled by analyst; counted as work)" };
    const summary = t.tools.length ? t.tools.map(x => `${x.name} ${x.args}`).join("; ").slice(0, 160) : (t.text.slice(0, 160) || "(empty turn)");
    return { ...l, costUsd: t.costUsd, durationMs: t.durationMs, summary };
  });
  const housekeeping = rows.filter(r => r.label === "housekeeping");
  const kept = rows.filter(r => r.label !== "housekeeping");
  const taskCompleteTurn = rows.filter(r => r.label !== "housekeeping" && r.repeatOf == null).reduce((m, r) => Math.max(m, r.turn), 0);
  return { analystModel, analystCostUsd, taskCompleteTurn, raw: totals(rows), throughTask: totals(kept), housekeeping: totals(housekeeping), turns: rows };
}

export function attribute(jsonlPath: string, task: string, totalCostUsd: number | null, model: string, tag: string): Attribution | null {
  const walk = buildWalk(fs.readFileSync(jsonlPath, "utf8"), totalCostUsd);
  if (walk.length === 0) { log(`[${tag}] Attribution: no turns in transcript`); return null; }
  log(`[${tag}] Attribution: labelling ${walk.length} turns with ${model}…`);
  const res = classifyTurns(walk, task, model);
  if (!res) return null;
  const a = rollup(walk, res.labels, res.modelUsed, res.analystCostUsd);
  log(`[${tag}] Attribution: ${a.housekeeping.turns} housekeeping turns = ${formatCost(a.housekeeping.costUsd)} / ${formatDuration(a.housekeeping.durationMs)}; through task: ${formatCost(a.throughTask.costUsd)} / ${formatDuration(a.throughTask.durationMs)} (analyst ${formatCost(res.analystCostUsd)})`);
  return a;
}
