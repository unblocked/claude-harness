import fs from "node:fs";
import type { ArmResult, ComparisonResult, EconomicsBreakdown } from "./types.ts";
import { priceFor } from "./util.ts";

// Deterministic decomposition of the cost, time and token differences between
// the two arms, computed the same way for both. It names which term moved a
// delta so the explanation that follows is anchored to arithmetic, not to a
// story. Everything here is over core work (housekeeping removed) when
// attribution exists, else over the whole run.

const isResearch = (name: string, input: Record<string, unknown>) =>
  name.toLowerCase().includes("unblocked") || (name === "Bash" && /^unblocked\s+context/.test(String(input.command ?? "")));

// Tokens of research results carried in context: for each research call, the
// size of what came back (chars/4) times the number of later main-thread
// messages that re-read it. An estimate of the cache-read tokens the research
// context itself accounts for.
function researchCarried(arm: ArmResult): { calls: number; payloadTokens: number; carriedTokens: number } {
  let jsonl = "";
  try { jsonl = fs.readFileSync(arm.run.jsonlPath, "utf8"); } catch { return { calls: 0, payloadTokens: 0, carriedTokens: 0 }; }
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pending = new Map<string, number>();  // tool_use id -> message index of the call
  const payloads: { atMessage: number; tokens: number }[] = [];
  const seen = new Set<string>();
  let msgIndex = 0;
  for (const e of events) {
    if (typeof e.parent_tool_use_id === "string") continue;
    if (e.type === "assistant") {
      const id = String(e.message?.id ?? "");
      if (!seen.has(id)) { seen.add(id); msgIndex++; }
      for (const b of e.message?.content ?? []) if (b.type === "tool_use" && b.name && isResearch(b.name, b.input ?? {})) pending.set(b.id, msgIndex);
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== "tool_result" || !pending.has(b.tool_use_id)) continue;
        const body = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(b.content ?? "");
        payloads.push({ atMessage: pending.get(b.tool_use_id)!, tokens: Math.round(body.length / 4) });
        pending.delete(b.tool_use_id);
      }
    }
  }
  const total = msgIndex;
  return {
    calls: payloads.length,
    payloadTokens: payloads.reduce((a, p) => a + p.tokens, 0),
    carriedTokens: payloads.reduce((a, p) => a + p.tokens * Math.max(0, total - p.atMessage), 0),
  };
}

function toolWaitByCategory(arm: ArmResult): Record<string, number> {
  // Wall time of tool calls by kind, using the per-call durations from the stream.
  const out: Record<string, number> = {};
  for (const tc of arm.run.toolCalls) {
    if (tc.nested || !(tc.durationMs ?? 0)) continue;
    const cmd = String(tc.args.command ?? "");
    const kind = tc.isMcp ? (tc.mcpServer?.toLowerCase().includes("unblocked") ? "research" : "mcp")
      : tc.name !== "Bash" ? "file ops"
      : /\b(rspec|bin\/ci|npm (test|run test)|go test|pytest|jest|make (test|check)|cargo test|mvn|gradle)\b/.test(cmd) ? "tests/CI"
      : /\b(rubocop|gofmt|go vet|tsc|eslint|lint)\b/.test(cmd) ? "lint/typecheck"
      : /\b(gh api|gh search|curl |wget |rails runner)\b/.test(cmd) ? "external lookups"
      : /^git\b|&& git\b|; git\b/.test(cmd) ? "git"
      : "shell";
    out[kind] = (out[kind] ?? 0) + (tc.durationMs ?? 0);
  }
  return out;
}

function armSide(arm: ArmResult) {
  const a = arm.attribution;
  const u = arm.run.tokenUsage;
  const totals = a ? a.core : { costUsd: arm.estimatedCost, durationMs: arm.run.durationMs, modelMs: 0, toolMs: 0, turns: arm.run.assistantTurns, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens };
  const models = Object.entries(u.byModel ?? {});
  const thinking = models.reduce((s, [, m]) => s + (m.thinkingTokens ?? 0), 0);
  const scale = u.outputTokens > 0 ? totals.outputTokens / u.outputTokens : 1; // core share of the run's output
  const research = researchCarried(arm);
  return {
    costUsd: totals.costUsd,
    durationMs: totals.durationMs, modelMs: totals.modelMs, toolMs: totals.toolMs,
    messages: totals.turns,
    outputTokens: totals.outputTokens,
    thinkingTokens: Math.round(thinking * scale),
    visibleTokens: Math.round(totals.outputTokens - thinking * scale),
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: u.cacheCreationTokens,
    inputTokens: u.inputTokens,
    contextPerMessage: totals.turns ? Math.round(totals.cacheReadTokens / totals.turns) : 0,
    research,
    toolWait: toolWaitByCategory(arm),
  };
}

export function economics(result: ComparisonResult): EconomicsBreakdown {
  const b = armSide(result.baseline);
  const u = armSide(result.unblocked);
  const price = priceFor(result.model);
  const perM = (n: number, rate: number) => (n / 1_000_000) * rate;
  // Cost delta by term, at the model's list rates (the billed total is what
  // the arms show; this is the attribution of the difference between them).
  const costTerms = {
    output: perM(u.outputTokens - b.outputTokens, price.output),
    cacheRead: perM(u.cacheReadTokens - b.cacheReadTokens, price.cacheRead),
    cacheWrite: perM(u.cacheWriteTokens - b.cacheWriteTokens, price.cacheWrite1h),
    input: perM(u.inputTokens - b.inputTokens, price.input),
  };
  const explained = Object.values(costTerms).reduce((s, v) => s + v, 0);
  return {
    baseline: b, unblocked: u,
    cost: { deltaUsd: u.costUsd - b.costUsd, terms: costTerms, unexplainedUsd: (u.costUsd - b.costUsd) - explained },
    cacheRead: {
      deltaTokens: u.cacheReadTokens - b.cacheReadTokens,
      researchCarriedTokens: u.research.carriedTokens - b.research.carriedTokens,
      contextPerMessageDelta: u.contextPerMessage - b.contextPerMessage,
      messagesDelta: u.messages - b.messages,
    },
    output: { deltaTokens: u.outputTokens - b.outputTokens, thinkingDelta: u.thinkingTokens - b.thinkingTokens, visibleDelta: u.visibleTokens - b.visibleTokens },
    time: { deltaMs: u.durationMs - b.durationMs, modelDeltaMs: u.modelMs - b.modelMs, toolDeltaMs: u.toolMs - b.toolMs,
      toolWaitDelta: Object.fromEntries([...new Set([...Object.keys(b.toolWait), ...Object.keys(u.toolWait)])].map(k => [k, (u.toolWait[k] ?? 0) - (b.toolWait[k] ?? 0)])) },
  };
}

// Plain-text rendering for the explainer prompt and the console.
export function describeEconomics(e: EconomicsBreakdown): string {
  const f = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const usd = (n: number) => (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
  const min = (ms: number) => (ms >= 0 ? "+" : "-") + (Math.abs(ms) / 60000).toFixed(1) + " min";
  const side = (label: string, s: EconomicsBreakdown["baseline"]) =>
    `${label}: cost $${s.costUsd.toFixed(2)}; time ${(s.durationMs / 60000).toFixed(1)} min (model ${(s.modelMs / 60000).toFixed(1)}, tool wait ${(s.toolMs / 60000).toFixed(1)}); ${s.messages} messages; output ${s.outputTokens.toLocaleString()} (thinking ${s.thinkingTokens.toLocaleString()}, visible ${s.visibleTokens.toLocaleString()}); cache-read ${s.cacheReadTokens.toLocaleString()} (avg context ${s.contextPerMessage.toLocaleString()}/message); research: ${s.research.calls} calls returning ~${s.research.payloadTokens.toLocaleString()} tokens, carried ~${s.research.carriedTokens.toLocaleString()} token-reads; tool wait by kind: ${Object.entries(s.toolWait).map(([k, v]) => `${k} ${(v / 60000).toFixed(1)} min`).join(", ") || "none"}`;
  return [
    side("BASELINE (core work)", e.baseline),
    side("UNBLOCKED (core work)", e.unblocked),
    `COST delta ${usd(e.cost.deltaUsd)} = output ${usd(e.cost.terms.output)} + cache-read ${usd(e.cost.terms.cacheRead)} + cache-write ${usd(e.cost.terms.cacheWrite)} + input ${usd(e.cost.terms.input)} (residual ${usd(e.cost.unexplainedUsd)} from rate/scaling differences)`,
    `CACHE-READ delta ${f(e.cacheRead.deltaTokens)} tokens; research context carried accounts for ~${f(e.cacheRead.researchCarriedTokens)}; average context per message ${f(e.cacheRead.contextPerMessageDelta)}; messages ${f(e.cacheRead.messagesDelta)}`,
    `OUTPUT delta ${f(e.output.deltaTokens)} tokens = thinking ${f(e.output.thinkingDelta)} + visible ${f(e.output.visibleDelta)}`,
    `TIME delta ${min(e.time.deltaMs)} = model ${min(e.time.modelDeltaMs)} + tool wait ${min(e.time.toolDeltaMs)}; tool wait by kind: ${Object.entries(e.time.toolWaitDelta).map(([k, v]) => `${k} ${min(v)}`).join(", ") || "none"}`,
  ].join("\n");
}
