import fs from "node:fs";
import type { ArmResult, ComparisonResult, ContextImpact } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { runStructured } from "./analyst.ts";
import { describeEconomics } from "./economics.ts";

// Context-impact assessment: un-blinded, run after the quality judge. Answers
// what the Unblocked context actually did — which returned items the agent
// used and for what, which facts the baseline found by other means, what the
// research should have surfaced and didn't, what the agent had and ignored —
// and whether the quality outcome (better, worse, similar) is attributable to
// the context, to the agent's own behaviour, or to neither.

interface ResearchCall { turn: number; tool: string; query: string; items: { title: string; chars: number; preview: string }[]; chars: number }

const isResearch = (name: string, input: Record<string, unknown>) =>
  name.toLowerCase().includes("unblocked") || (name === "Bash" && /^unblocked\s+context/.test(String(input.command ?? "")));

// External lookups the baseline can make without the research tool: the
// enterprise GitHub API, curl, web fetch, database probes.
const isExternal = (name: string, input: Record<string, unknown>) =>
  /^(WebFetch|WebSearch)$/.test(name) || (name === "Bash" && /\b(gh (api|search|pr|repo)|curl |wget |rails runner|psql |mysql )/.test(String(input.command ?? "")));

function excerpt(s: string, n: number): string { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }

// Compact walk: one line per tool call, args only. Research calls carry their
// returned items (title, size, short preview); external lookups are marked.
function walkAndResearch(arm: ArmResult): { walk: string; research: ResearchCall[] } {
  let jsonl = "";
  try { jsonl = fs.readFileSync(arm.run.jsonlPath, "utf8"); } catch { return { walk: "(transcript unavailable)", research: [] }; }
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const lines: string[] = [];
  const research: ResearchCall[] = [];
  const pendingResearch = new Map<string, ResearchCall>();
  let turn = 0;
  const seen = new Set<string>();
  for (const e of events) {
    if (typeof e.parent_tool_use_id === "string") continue;
    if (e.type === "assistant") {
      const id = String(e.message?.id ?? "");
      if (!seen.has(id)) { seen.add(id); turn++; }
      for (const b of e.message?.content ?? []) {
        if (b.type === "text" && b.text) lines.push(`T${turn} says: ${excerpt(b.text, 120)}`);
        if (b.type !== "tool_use" || !b.name) continue;
        const input = b.input ?? {};
        const arg = input.command ?? input.query ?? input.url ?? input.urls ?? input.file_path ?? input.pattern ?? JSON.stringify(input);
        if (isResearch(b.name, input)) {
          const rc: ResearchCall = { turn, tool: b.name.split(/__|::/).pop() ?? b.name, query: excerpt(String(arg), 300), items: [], chars: 0 };
          research.push(rc); pendingResearch.set(b.id, rc);
          lines.push(`T${turn} RESEARCH ${rc.tool}: ${rc.query}`);
        } else {
          lines.push(`T${turn} ${isExternal(b.name, input) ? "EXTERNAL-LOOKUP " : ""}${b.name}: ${excerpt(String(arg), 140)}`);
        }
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== "tool_result") continue;
        const rc = pendingResearch.get(b.tool_use_id);
        if (!rc) continue;
        pendingResearch.delete(b.tool_use_id);
        const body = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(b.content ?? "");
        rc.chars = body.length;
        if (b.is_error) { rc.items.push({ title: "[ERROR]", chars: body.length, preview: excerpt(body, 200) }); continue; }
        for (const item of body.split(/\n---\n/)) {
          const title = item.match(/\*\*Title\*\*: (.*)/)?.[1]?.trim() ?? excerpt(item, 80);
          const url = item.match(/\*\*URL\*\*: (\S+)/)?.[1] ?? "";
          rc.items.push({ title: excerpt(title + (url ? ` <${url}>` : ""), 160), chars: item.length, preview: excerpt(item.replace(/\*\*Title\*\*: .*|\*\*URL\*\*: .*/g, ""), 260) });
        }
      }
    }
  }
  return { walk: lines.join("\n"), research };
}

const SCHEMA = {
  type: "object",
  properties: {
    research: { type: "array", items: { type: "object", properties: {
      turn: { type: "integer" }, query: { type: "string" },
      itemsReturned: { type: "integer" },
      itemsUsed: { type: "array", items: { type: "object", properties: { item: { type: "string" }, use: { type: "string" } }, required: ["item", "use"] } },
      value: { type: "string", enum: ["decisive", "useful", "unused", "misleading"] },
      note: { type: "string" },
    }, required: ["turn", "query", "itemsReturned", "itemsUsed", "value", "note"] } },
    contextFacts: { type: "array", items: { type: "object", properties: {
      fact: { type: "string" }, usedFor: { type: "string" }, evidence: { type: "string" },
    }, required: ["fact", "usedFor", "evidence"] } },
    baselineDiscoveries: { type: "array", items: { type: "object", properties: {
      fact: { type: "string" }, how: { type: "string" }, unblockedHadIt: { type: "boolean" },
    }, required: ["fact", "how", "unblockedHadIt"] } },
    gaps: { type: "array", items: { type: "object", properties: {
      missing: { type: "string" }, evidence: { type: "string" }, consequence: { type: "string" },
    }, required: ["missing", "evidence", "consequence"] } },
    unused: { type: "array", items: { type: "object", properties: {
      had: { type: "string" }, consequence: { type: "string" },
    }, required: ["had", "consequence"] } },
    impact: { type: "object", properties: {
      outcome: { type: "string", enum: ["better", "worse", "similar"] },
      contextRole: { type: "string", enum: ["decisive", "significant", "minor", "none", "harmful"] },
      summary: { type: "string" },
      whatWouldChange: { type: "string" },
    }, required: ["outcome", "contextRole", "summary", "whatWouldChange"] },
    economics: { type: "object", properties: {
      cost: { type: "string" }, time: { type: "string" }, tokens: { type: "string" },
    }, required: ["cost", "time", "tokens"] },
  },
  required: ["research", "contextFacts", "baselineDiscoveries", "gaps", "unused", "impact", "economics"],
};

function prompt(result: ComparisonResult): string {
  const u = walkAndResearch(result.unblocked);
  const b = walkAndResearch(result.baseline);
  const q = result.quality;
  const researchBlock = u.research.map(rc => `--- Research call at T${rc.turn} (${rc.tool}), ${rc.chars} chars returned ---
query: ${rc.query}
${rc.items.map((it, i) => `  [${i + 1}] ${it.title} (${it.chars} chars)\n      ${it.preview}`).join("\n") || "  (nothing returned)"}`).join("\n\n");
  const verdict = q ? `Verdict: ${q.verdict.better} (${q.verdict.confidence}). ${q.verdict.rationale}
Requirements: ${q.requirements.map(r => `"${r.requirement}" baseline=${r.baseline.status}, unblocked=${r.unblocked.status}`).join("; ")}
Findings: ${q.findings.map(f => `(${f.arm}) ${f.finding}`).join(" | ")}` : "(no quality verdict available)";

  return `Two autonomous coding agents did the same task in identical copies of one repository. The UNBLOCKED agent had a research tool (Unblocked) that searches the organisation's PRs, docs, chat, issues and other repositories; the BASELINE agent did not, but could use anything else, including the enterprise GitHub API. An independent blinded judge has already compared their outputs. Your job is narrower and un-blinded: determine what the research context actually did.

Answer these, with evidence from the material below:
1. For each research call: how many items came back, which of them the UNBLOCKED agent actually used (cited in its final response, acted on in code or comments, led to a follow-up read) and for what, and whether the call was decisive, useful, unused, or misleading (returned something that led the agent to a wrong conclusion, including a confident "nothing found").
2. contextFacts: the specific facts the UNBLOCKED agent got from research and used, with what each was used for.
3. baselineDiscoveries: facts the BASELINE agent found by other means (reading the repo, external lookups such as the GitHub API, probing), and for each whether the UNBLOCKED agent also had that fact (from research or on its own).
4. gaps: what the research should have surfaced for this task but did not, judged by what the baseline found elsewhere or what the task pointed at, and the consequence for the UNBLOCKED agent's result.
5. unused: context the UNBLOCKED agent had (from research or its own reading) and failed to use, and the consequence.
6. impact: given the judge's verdict, was the UNBLOCKED outcome better, worse or similar; what role the research context played in that (decisive, significant, minor, none, or harmful); a short summary a customer could read; and what single change (to the context returned, or to how the agent used it) would most have changed the result.
7. economics: three short explanations (2–4 sentences each) of why the two arms differ in cost, in time, and in tokens, for a customer. Each must be grounded in the ECONOMICS BREAKDOWN below: name the term that moved the delta and its size, then say what in the transcripts caused that term (a research payload re-read every message, a full test suite versus a subset, more thinking, more messages spent on a decision, a loop, an external lookup). Say plainly when a cost bought something (a fact the other arm never got) and when it bought nothing. Same standard for both arms; do not soften one side.

Attribute causes precisely. "The agent ran more tests" is agent behaviour, not context. "The agent chose sdlc because a research item showed the org roster" is context. "The agent said no prior art existed because the research summary said none was surfaced, while the baseline found it with a code search" is a context gap with a consequence.

=================== TASK ===================
${result.task}

=================== ECONOMICS BREAKDOWN (core work, housekeeping removed; computed, not estimated by you) ===================
${result.economics ? describeEconomics(result.economics) : "(not available)"}

=================== QUALITY JUDGE (blinded) ===================
${verdict}

=================== UNBLOCKED AGENT: RESEARCH CALLS AND WHAT CAME BACK ===================
${researchBlock || "(the agent made no research calls)"}

=================== UNBLOCKED AGENT: TRANSCRIPT WALK (tool calls only) ===================
${u.walk}

=================== UNBLOCKED AGENT: FINAL RESPONSE ===================
${result.unblocked.run.finalResponse}

=================== BASELINE AGENT: TRANSCRIPT WALK (tool calls only; EXTERNAL-LOOKUP marks non-repo sources) ===================
${b.walk}

=================== BASELINE AGENT: FINAL RESPONSE ===================
${result.baseline.run.finalResponse}
`;
}

export function assessImpact(result: ComparisonResult, model: string): ContextImpact | null {
  const p = prompt(result);
  log(`Impact: assessing context impact with ${model} (${Math.round(p.length / 1000)}k chars)…`);
  const res = runStructured<Omit<ContextImpact, "model" | "costUsd">>("Impact", p, model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const out: ContextImpact = { ...res.data, model: res.modelUsed, costUsd: res.costUsd };
  log(`Impact: outcome ${out.impact.outcome}, context role ${out.impact.contextRole}; ${formatCost(out.costUsd)} via ${res.modelUsed}`);
  return out;
}
