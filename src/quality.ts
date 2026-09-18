import fs from "node:fs";
import type { ArmResult, ComparisonResult, Condition, QualityAssessment, ReviewSpec } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { neutralise, runStructured, VERIFY_CMD } from "./analyst.ts";

// Blinded quality judgement of the two arms' output. The judge sees the task,
// each arm's final response, diff, and verification record, labelled A and B
// in random order. It extracts the task's requirements, grades each arm on
// them, scores a fixed set of criteria, lists notable findings and gives a
// verdict. Un-blinded before it is stored. It never sees which arm had the
// research tool, and mentions of it in the agents' own text are neutralised.

const DIFF_BUDGET = 40_000;   // chars of diff per arm shown to the judge

export const CRITERIA = [
  { key: "completeness", text: "Completeness: how much of the task's stated requirements was delivered. Work beyond the requirements does not raise this score." },
  { key: "correctness", text: "Correctness within scope: does the required behaviour work, and does the change avoid introducing defects or regressions in the code it touches. A risk that existed before the change and that the task did not ask to address is not a defect of either agent." },
  { key: "discovery", text: "Discovery: did the agent find the existing conventions, prior art and constraints it needed to meet the requirements the way this codebase does it. Finding things the requirements did not need is not scored." },
  { key: "verification", text: "Verification: was the required behaviour verified, by tests for it in the repository's style that were run and passed. Extra experiments beyond verifying the requirements do not raise this score." },
  { key: "honesty", text: "Honesty of the final report: are claims verified where they say verified, inferences labelled as inferences, and nothing stated that the transcript contradicts." },
  { key: "hygiene", text: "Change hygiene: is the diff proportionate to the requirements, free of vendored bulk or generated junk, and would a reviewer accept it without asking for cleanup." },
];


function verificationRecord(arm: ArmResult, jsonl: string): string {
  // Test/CI commands and the tail of their output, straight from the
  // transcript. An agent may run a build in the background with its output
  // redirected to a log and read the result later with grep/tail/cat; the
  // record follows those reads, and the CLI's completion notification for a
  // background command, so a background build is not mistaken for no
  // verification.
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pending = new Map<string, string>();       // tool_use id -> command
  const verifyIds = new Set<string>();             // tool_use ids of verify commands (for background notifications)
  const logs = new Set<string>();                  // files verify output was redirected to
  const lines: string[] = [];
  const tail = (t: string) => t.replace(/\s+/g, " ").trim().slice(-400);
  for (const e of events) {
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use" || b.name !== "Bash") continue;
        const cmd = String(b.input?.command ?? "");
        const readsLog = [...logs].some(l => cmd.includes(l));
        if (VERIFY_CMD.test(cmd) || readsLog) {
          pending.set(b.id, cmd.replace(/\s+/g, " ").slice(0, 160));
          if (VERIFY_CMD.test(cmd)) {
            verifyIds.add(b.id);
            for (const m of cmd.matchAll(/>{1,2}\s*(\/[^\s;&|)]+\.(?:log|txt|out))/g)) logs.add(m[1]);
          }
        }
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== "tool_result" || !pending.has(b.tool_use_id)) continue;
        const body = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(b.content ?? "");
        lines.push(`$ ${pending.get(b.tool_use_id)}\n  -> ${tail(body)}`);
        pending.delete(b.tool_use_id);
      }
    } else if (e.type === "system" && e.subtype === "task_notification" && verifyIds.has(String(e.tool_use_id))) {
      let extra = "";
      try { if (e.output_file && fs.existsSync(e.output_file)) extra = ` | output tail: ${tail(fs.readFileSync(e.output_file, "utf8"))}`; } catch {}
      lines.push(`[background command finished] ${String(e.summary ?? "").replace(/\s+/g, " ")}${e.status ? ` (${e.status})` : ""}${extra}`);
    }
  }
  return lines.length ? lines.join("\n") : "(no test, lint, build or CI commands were run)";
}

// The reviewer's record for one arm: the last pass's verdict per requirement,
// its open comments, and how many rounds it took. Same reviewer, same list,
// same rubric for both arms, so the judge can start from it.
function reviewRecord(label: string, arm: ArmResult): string {
  const rv = arm.review;
  if (!rv || !rv.passes.length) return "";
  const last = rv.passes[rv.passes.length - 1];
  const fixes = rv.passes.filter(p => p.fix).length;
  return `
--- Code review of agent ${label}'s final revision (${rv.passes.length} review round(s), ${fixes} fix pass(es); ${last.mergeable ? "mergeable" : "not mergeable"}) ---
Per requirement: ${last.requirements.map(r => `${(r.index ?? 0) + 1} ${r.status}${r.note ? ` (${r.note})` : ""}`).join("; ")}
${last.comments?.length ? `Open comments: ${last.comments.map(c => `[${c.severity}] ${c.file.split("/").slice(-1)[0]}: ${c.comment}`).join(" | ")}\n` : ""}Reviewer's summary: ${last.summary}
`;
}

function armBlock(label: string, arm: ArmResult): string {
  let jsonl = "";
  try { jsonl = fs.readFileSync(arm.run.jsonlPath, "utf8"); } catch {}
  const diff = arm.diff.length > DIFF_BUDGET ? arm.diff.slice(0, DIFF_BUDGET) + `\n… (diff truncated; ${arm.diffStats.filesChanged} files, +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved} in total)` : arm.diff;
  return `=================== ARM ${label} ===================
--- Final response from agent ${label} ---
${neutralise(arm.run.finalResponse)}
${neutralise(reviewRecord(label, arm))}

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
          index: { type: "integer" },
          requirement: { type: "string" },
          A: { type: "object", properties: { status: { type: "string", enum: ["met", "partial", "unmet"] }, evidence: { type: "string" } }, required: ["status", "evidence"] },
          B: { type: "object", properties: { status: { type: "string", enum: ["met", "partial", "unmet"] }, evidence: { type: "string" } }, required: ["status", "evidence"] },
        },
        required: ["index", "requirement", "A", "B"],
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
      properties: { better: { type: "string", enum: ["A", "B", "tie"] }, rationale: { type: "string" } },
      required: ["better", "rationale"],
    },
  },
  required: ["requirements", "criteria", "findings", "verdict"],
};

function judgePrompt(task: string, first: ArmResult, second: ArmResult, spec: ReviewSpec | undefined): string {
  // With a shared review standard the judge grades the same numbered list the
  // reviewers used, so the two tables are comparable line by line. A waived
  // requirement is not graded.
  const waived = new Set((spec?.adjudications ?? []).filter(a => a.waived).map(a => a.index));
  const reviewed = [first, second].some(a => a.review?.passes.length);
  const step1 = spec
    ? `1. The task's requirements are fixed and numbered below. Grade each agent on each one, by its number, met / partial / unmet, with evidence ≤ 12 words drawn from its response or diff. Copy the requirement text as given; do not add, merge or reword requirements. Skip the ones marked waived, and read a requirement marked "does not cover X" as excluding X for both agents.${reviewed ? " A requirement check has already graded each agent's final revision against this list; its record is under each agent's response. Start from those grades: keep a grade unless the diff or the verification record plainly contradicts it, and when you change one, say why in the evidence." : ""}
${spec.requirements.map((r, i) => `   ${i + 1}. ${r}${waived.has(i) ? "   [waived — do not grade]" : (spec.adjudications.filter(a => a.index === i && a.excludes).map(a => a.excludes).length ? `   [does not cover: ${spec.adjudications.filter(a => a.index === i && a.excludes).map(a => a.excludes).join("; ")}]` : "")}`).join("\n")}`
    : `1. Extract the task's explicit requirements, one per distinct thing it asks for, each ≤ 10 words, numbered from 1. For each, grade each agent met / partial / unmet with evidence ≤ 12 words drawn from its response or diff.`;
  return `Two autonomous coding agents, A and B, were given the same task in identical copies of the same repository. You are judging the quality of what each produced. You will see the task, then for each agent its final written response, the verification commands it ran with the end of their output, and its diff. Judge only from this material. Do not guess at anything you cannot see.

Do the following. Every string you write goes on a one-page report, so keep them short.
${step1}
2. Score each agent 1 to 5 on each criterion below, rationale ≤ 15 words naming concrete evidence. Use the full range.
${CRITERIA.map(c => `   - ${c.key}: ${c.text}`).join("\n")}
3. List at most 4 findings a reviewer would need, each ≤ 20 words, tied to one agent with evidence ≤ 15 words. Prefer claims the diff or verification record contradicts, and defects the change introduces within the requirements' scope.
4. verdict: which agent's result is better, decided in this order and no other:
   (a) requirements: the agent that meets more of them, or meets them more fully, wins;
   (b) if requirements are equal: an agent whose change introduces a defect in the required behaviour, or a regression in the code it touches, loses to one that does not;
   (c) if still equal: hygiene, only when the difference is material (vendored bulk, generated junk, changes to unrelated files);
   (d) otherwise "tie".
   Things that never decide the verdict: hardening of cases the task did not name, extra experiments or checks beyond verifying the required behaviour, deployment or rollout notes, self-review passes, the length or polish of the write-up, the size of the diff by itself. A "tie" is the expected verdict when both agents meet every requirement without introducing a defect. The rationale, ≤ 2 sentences, must name the requirement or the introduced defect that decided it.

Be even-handed. A larger diff is not better. More words are not better. More work is not better. A wrong answer stated confidently is worse than a right answer with caveats.

In every string you write, refer to the agents only as "Agent A" and "Agent B" (possessive: "Agent A's"). Never a bare "A" or "B": those labels are replaced with real names afterwards, and a bare letter cannot be told apart from an article.

=================== TASK ===================
${task}

${armBlock("A", first)}
${armBlock("B", second)}`;
}

type Raw = {
  requirements: { index: number; requirement: string; A: { status: "met" | "partial" | "unmet"; evidence: string }; B: { status: "met" | "partial" | "unmet"; evidence: string } }[];
  criteria: { key: string; A: { score: number; rationale: string }; B: { score: number; rationale: string } }[];
  findings: { arm: "A" | "B"; finding: string; evidence: string }[];
  verdict: { better: "A" | "B" | "tie"; rationale: string };
};

export async function assessQuality(result: ComparisonResult, model: string): Promise<QualityAssessment | null> {
  // A placeholder where the diff should be means the judge would be grading a sentinel.
  for (const arm of [result.baseline, result.unblocked]) {
    if (!arm.diff || arm.diff.startsWith("(")) { log(`Quality: skipping judge, ${arm.condition} arm has no diff to judge (${arm.diff.slice(0, 60)})`); return null; }
  }

  // Blind: random order, so "A" is baseline half the time.
  const aIsBaseline = Math.random() < 0.5;
  const first = aIsBaseline ? result.baseline : result.unblocked;
  const second = aIsBaseline ? result.unblocked : result.baseline;
  const cond = (l: "A" | "B"): Condition => (l === "A") === aIsBaseline ? "baseline" : "unblocked";

  const prompt = judgePrompt(result.task, first, second, result.reviewSpec);
  log(`Quality: judging with ${model} (${Math.round(prompt.length / 1000)}k chars, arm A = ${aIsBaseline ? "baseline" : "unblocked"})…`);
  // Unredacted: the judge must see digests, env var names and auth headers as written.
  const res = await runStructured<Raw>("Quality", prompt, model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const raw = res.data;

  const pick = <T>(row: { A: T; B: T }, c: Condition): T => (cond("A") === c ? row.A : row.B);
  // Un-blind the prose: "Agent A" / "Agent B" become the arm names the reader knows.
  const nameOf = (l: "A" | "B") => (cond(l) === "baseline" ? "Baseline" : "Unblocked");
  const unblind = (t: string) => t.replace(/\b[Aa]gent ([AB])\b/g, (_, l: "A" | "B") => nameOf(l));
  const ub = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? unblind(v) : v])) as T;
  const q: QualityAssessment = {
    judgeModel: res.modelUsed,
    judgeCostUsd: res.costUsd,
    armA: aIsBaseline ? "baseline" : "unblocked",
    requirements: raw.requirements.map(r => {
      const i = r.index - 1;
      const shared = result.reviewSpec && i >= 0 && i < result.reviewSpec.requirements.length;
      return { ...(shared ? { index: i } : {}), requirement: shared ? result.reviewSpec!.requirements[i] : unblind(r.requirement), baseline: ub(pick(r, "baseline")), unblocked: ub(pick(r, "unblocked")) };
    }),
    criteria: raw.criteria.map(c => ({ criterion: c.key, baseline: ub(pick(c, "baseline")), unblocked: ub(pick(c, "unblocked")) })),
    findings: raw.findings.map(f => ({ arm: cond(f.arm), finding: unblind(f.finding), evidence: unblind(f.evidence) })),
    verdict: { better: raw.verdict.better === "tie" ? "tie" : cond(raw.verdict.better), rationale: unblind(raw.verdict.rationale) },
  };
  log(`Quality: verdict ${q.verdict.better}; judge ${formatCost(q.judgeCostUsd)} via ${res.modelUsed}`);
  return q;
}
