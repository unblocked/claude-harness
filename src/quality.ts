import fs from "node:fs";
import type { ArmResult, ComparisonResult, Condition, QualityAssessment } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { runStructured } from "./analyst.ts";

// Blinded quality judgement of the two arms' output. The judge sees the task,
// each arm's final response, diff, and verification record, labelled A and B
// in random order. It extracts the task's requirements, grades each arm on
// them, scores a fixed set of criteria, lists notable findings and gives a
// verdict. Un-blinded before it is stored. It never sees which arm had the
// research tool, and mentions of it in the agents' own text are neutralised.

const DIFF_BUDGET = 40_000;   // chars of diff per arm shown to the judge
const VERIFY_CMD = /\b(rspec|bin\/ci|npm (test|run test)|go test|go vet|gofmt|go build|rubocop|tsc|pytest|jest|make (test|check)|cargo test|mvn|gradle)\b/;

export const CRITERIA = [
  { key: "completeness", text: "Completeness: how much of the task, as stated, was actually delivered." },
  { key: "correctness", text: "Correctness and best practice: does the change work, follow the repository's and organisation's existing conventions, and avoid inventing patterns when one already exists." },
  { key: "discovery", text: "Discovery: did the agent surface the important unknowns, prior art, risks and gotchas that a careful engineer would want raised, and act on them." },
  { key: "verification", text: "Verification: were the right tests, checks and CI run, and were new specs added in the repository's style." },
  { key: "honesty", text: "Honesty of the final report: are claims verified where they say verified, inferences labelled as inferences, and nothing stated that the transcript contradicts." },
  { key: "hygiene", text: "Change hygiene: is the diff proportionate, free of vendored bulk or generated junk, and would a reviewer accept it without asking for cleanup." },
];

function neutralise(s: string): string {
  return s.replace(/unblocked/gi, "the research tool").replace(/context_research|context_get_urls|context_search_\w+/g, "research_tool");
}

function verificationRecord(arm: ArmResult, jsonl: string): string {
  // Test/CI commands and the tail of their output, straight from the transcript.
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pending = new Map<string, string>();
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type === "tool_use" && b.name === "Bash" && VERIFY_CMD.test(String(b.input?.command ?? ""))) pending.set(b.id, String(b.input.command).replace(/\s+/g, " ").slice(0, 160));
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== "tool_result" || !pending.has(b.tool_use_id)) continue;
        const body = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(b.content ?? "");
        lines.push(`$ ${pending.get(b.tool_use_id)}\n  -> ${body.replace(/\s+/g, " ").trim().slice(-400)}`);
        pending.delete(b.tool_use_id);
      }
    }
  }
  return lines.length ? lines.join("\n") : "(no test, lint, build or CI commands were run)";
}

function armBlock(label: string, arm: ArmResult): string {
  let jsonl = "";
  try { jsonl = fs.readFileSync(arm.run.jsonlPath, "utf8"); } catch {}
  const diff = arm.diff.length > DIFF_BUDGET ? arm.diff.slice(0, DIFF_BUDGET) + `\n… (diff truncated; ${arm.diffStats.filesChanged} files, +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved} in total)` : arm.diff;
  return `=================== ARM ${label} ===================
--- Final response from agent ${label} ---
${neutralise(arm.run.finalResponse)}

--- Verification commands agent ${label} ran, with the end of their output ---
${neutralise(verificationRecord(arm, jsonl))}

--- Diff produced by agent ${label} (${arm.diffStats.filesChanged} files, +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved}) ---
${neutralise(diff)}
`;
}

const SCHEMA = {
  type: "object",
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requirement: { type: "string" },
          A: { type: "object", properties: { status: { type: "string", enum: ["met", "partial", "unmet"] }, evidence: { type: "string" } }, required: ["status", "evidence"] },
          B: { type: "object", properties: { status: { type: "string", enum: ["met", "partial", "unmet"] }, evidence: { type: "string" } }, required: ["status", "evidence"] },
        },
        required: ["requirement", "A", "B"],
      },
    },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          A: { type: "object", properties: { score: { type: "integer" }, rationale: { type: "string" } }, required: ["score", "rationale"] },
          B: { type: "object", properties: { score: { type: "integer" }, rationale: { type: "string" } }, required: ["score", "rationale"] },
        },
        required: ["key", "A", "B"],
      },
    },
    findings: {
      type: "array",
      items: { type: "object", properties: { arm: { type: "string", enum: ["A", "B"] }, finding: { type: "string" }, evidence: { type: "string" } }, required: ["arm", "finding", "evidence"] },
    },
    verdict: {
      type: "object",
      properties: { better: { type: "string", enum: ["A", "B", "tie"] }, confidence: { type: "string", enum: ["low", "medium", "high"] }, rationale: { type: "string" } },
      required: ["better", "confidence", "rationale"],
    },
  },
  required: ["requirements", "criteria", "findings", "verdict"],
};

function judgePrompt(task: string, first: ArmResult, second: ArmResult): string {
  return `Two autonomous coding agents, A and B, were given the same task in identical copies of the same repository. You are judging the quality of what each produced. You will see the task, then for each agent its final written response, the verification commands it ran with the end of their output, and its diff. Judge only from this material. Do not guess at anything you cannot see.

Do the following:
1. Extract the task's explicit requirements as a list of short statements, one per distinct thing the task asks for (a decision to make, a change to make, a constraint to respect, something to state in the final response). Keep them to the task's own words where possible. For each requirement, grade each agent met / partial / unmet with one sentence of evidence from its response or diff.
2. Score each agent 1 to 5 on each criterion below, with a one-sentence rationale that names concrete evidence. Use the full range: 5 means a careful senior engineer would find nothing to add, 1 means the criterion was failed outright.
${CRITERIA.map(c => `   - ${c.key}: ${c.text}`).join("\n")}
3. List the notable findings, good or bad, that a reviewer of these two changes would want to know, each tied to one agent with evidence. Include any claim in a final response that the diff or verification record contradicts, and any place one agent found something important the other missed.
4. Give a verdict: which agent's result is better, with confidence and a short rationale. "tie" only if they are genuinely equivalent.

Be specific and even-handed. A larger diff is not better. More words in the final response are not better. The same wrong answer stated confidently is worse than a right answer stated with caveats.

=================== TASK ===================
${task}

${armBlock("A", first)}
${armBlock("B", second)}`;
}

type Raw = {
  requirements: { requirement: string; A: { status: "met" | "partial" | "unmet"; evidence: string }; B: { status: "met" | "partial" | "unmet"; evidence: string } }[];
  criteria: { key: string; A: { score: number; rationale: string }; B: { score: number; rationale: string } }[];
  findings: { arm: "A" | "B"; finding: string; evidence: string }[];
  verdict: { better: "A" | "B" | "tie"; confidence: "low" | "medium" | "high"; rationale: string };
};

export function assessQuality(result: ComparisonResult, model: string): QualityAssessment | null {
  // A placeholder where the diff should be means the judge would be grading a sentinel.
  for (const arm of [result.baseline, result.unblocked]) {
    if (!arm.diff || arm.diff.startsWith("(")) { log(`Quality: skipping judge, ${arm.condition} arm has no diff to judge (${arm.diff.slice(0, 60)})`); return null; }
  }

  // Blind: random order, so "A" is baseline half the time.
  const aIsBaseline = Math.random() < 0.5;
  const first = aIsBaseline ? result.baseline : result.unblocked;
  const second = aIsBaseline ? result.unblocked : result.baseline;
  const cond = (l: "A" | "B"): Condition => (l === "A") === aIsBaseline ? "baseline" : "unblocked";

  const prompt = judgePrompt(result.task, first, second);
  log(`Quality: judging with ${model} (${Math.round(prompt.length / 1000)}k chars, arm A = ${aIsBaseline ? "baseline" : "unblocked"})…`);
  // Unredacted: the judge must see digests, env var names and auth headers as written.
  const res = runStructured<Raw>("Quality", prompt, model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const raw = res.data;

  const pick = <T>(row: { A: T; B: T }, c: Condition): T => (cond("A") === c ? row.A : row.B);
  const q: QualityAssessment = {
    judgeModel: res.modelUsed,
    judgeCostUsd: res.costUsd,
    requirements: raw.requirements.map(r => ({ requirement: r.requirement, baseline: pick(r, "baseline"), unblocked: pick(r, "unblocked") })),
    criteria: raw.criteria.map(c => ({ criterion: c.key, baseline: pick(c, "baseline"), unblocked: pick(c, "unblocked") })),
    findings: raw.findings.map(f => ({ arm: cond(f.arm), finding: f.finding, evidence: f.evidence })),
    verdict: { better: raw.verdict.better === "tie" ? "tie" : cond(raw.verdict.better), confidence: raw.verdict.confidence, rationale: raw.verdict.rationale },
  };
  log(`Quality: verdict ${q.verdict.better} (${q.verdict.confidence}); judge ${formatCost(q.judgeCostUsd)} via ${res.modelUsed}`);
  return q;
}
