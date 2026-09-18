import type { ArmResult, Condition, ReviewPass, ReviewRequirement, ReviewSpec } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { neutralise, runStructured } from "./analyst.ts";

// Requirement check, held to one standard for both arms. The reviewer has
// one job: for each of the task's requirements, say whether the change
// meets it, and if not, why. It does not comment on code, suggest work,
// rate quality or add requirements; that is the judge's job, after the
// fact, and anything more here would steer the agents.
//
// - The requirements are extracted from the task once, before either arm
//   runs, and every check uses that same numbered list.
// - The reviewer never waives anything. If an agent disputes a requirement
//   in its fix pass, an arm-blind adjudicator (task, list, dispute text; no
//   diff, no arm name) decides, and a waiver applies to both arms.
// - mergeable: every requirement met or waived.
//
// The reviewer sees only its own arm: the task, the agent's final response
// as the PR description, and the diff.

const DIFF_BUDGET = 60_000;

// Hide the treatment, not the repository. Only the tool's own names go:
// "Unblocked MCP/context/research/CLI", the MCP tool names. A bare
// "unblocked" stays, because the repository under test is called that and
// its paths, packages and files carry the word.

// ---- Requirements, once per run --------------------------------------------

const SPEC_SCHEMA = {
  type: "object",
  properties: { requirements: { type: "array", items: { type: "string" } } },
  required: ["requirements"],
};

export async function extractRequirements(task: string, model: string): Promise<ReviewSpec | null> {
  log(`Review: extracting the task's requirements with ${model}…`);
  const prompt = `A change will be checked against this task. List every explicit requirement and acceptance criterion the task states, one per entry, ≤ 20 words each, in the order the task gives them. Include deliverables the task names (for example tests, a changelog entry) as their own entries. Keep an "either X or Y" criterion as one entry that names both alternatives; never split alternatives into separate requirements, and never split one criterion into a condition and its consequence. Do not add requirements the task does not state, and do not restate motivation as a requirement.

=================== TASK ===================
${task}
`;
  const res = await runStructured<{ requirements: string[] }>("Requirements", prompt, model, SPEC_SCHEMA, 5 * 60 * 1000, false);
  if (!res) return null;
  const requirements = res.data.requirements.map(r => r.trim()).filter(Boolean);
  log(`Review: ${requirements.length} requirement(s) — ${requirements.map((r, i) => `${i + 1}. ${r}`).join("; ")}; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { model: res.modelUsed, costUsd: res.costUsd, requirements, adjudications: [] };
}

const waivedIndices = (spec: ReviewSpec) => new Set(spec.adjudications.filter(a => a.waived).map(a => a.index));

// ---- One review pass --------------------------------------------------------

const SCHEMA = {
  type: "object",
  properties: {
    requirements: { type: "array", items: { type: "object", properties: {
      index: { type: "integer" },
      status: { type: "string", enum: ["met", "partial", "unmet"] },
      note: { type: "string" },
    }, required: ["index", "status", "note"] } },
    summary: { type: "string" },
  },
  required: ["requirements", "summary"],
};

function prompt(task: string, arm: ArmResult, round: number, previous: ReviewPass | null, spec: ReviewSpec, disputed: string): string {
  const diff = arm.diff.length > DIFF_BUDGET ? arm.diff.slice(0, DIFF_BUDGET) + "\n… (diff truncated)" : arm.diff;
  const waived = waivedIndices(spec);
  const list = spec.requirements.map((r, i) => `${i + 1}. ${r}${waived.has(i) ? "   [WAIVED — do not check; report it as met]" : ""}`).join("\n");
  const waiverNotes = spec.adjudications.map(a => `- Requirement ${a.index + 1}: ${a.waived ? "waived" : "dispute rejected, still required"} — ${a.reason}`).join("\n");
  const prior = previous ? `
This is round ${round}. In round ${previous.round} you marked: ${previous.requirements.map((r, i) => `${i + 1} ${r.status}${r.status === "met" || r.status === "waived" ? "" : ` (${r.note})`}`).join("; ")}. Judge the current state, not the history.${disputed ? `
The engineer disputes part of that: """${neutralise(disputed)}""". Where they say a requirement is already satisfied, re-check it against the diff and description and grade what you find. Where they say a requirement should not apply, that is decided elsewhere; grade it as you find it.` : ""}` : "";
  return `You are checking whether an engineer's change meets the requirements of the task it was written for. You have the task, the engineer's summary of the change, and the diff of their working tree against the base branch. Nothing has been committed, pushed or branched: the diff is uncommitted work, and its existence says nothing about commits or branches.

Your only job is classification. For each numbered requirement below, mark it:
- met: the diff delivers it for every case the task covers;
- partial: the diff delivers it for some cases the task covers, not all;
- unmet: the diff does not deliver it.
With a note ≤ 25 words. For met, cite where in the diff. For partial or unmet, say exactly which case or part is missing, citing the diff or the description. Judge from the diff; a claim in the description that the diff does not show is not evidence. The exception is a requirement about process that a diff cannot show (not committing, not branching, how something was run): accept the description unless the diff contradicts it.

Do not add requirements, do not comment on code quality, style, tests, naming, logging or robustness beyond what a requirement states, and do not suggest changes or extra work. If the description argues that a requirement should not apply, do not waive it: mark it as you find it and quote the argument in the note; disputes are decided elsewhere.
${prior}
${list}
${waiverNotes ? `\nDecisions already made on disputes:\n${waiverNotes}\n` : ""}
summary: ≤ 2 sentences, which requirements are not met and why.

=================== TASK ===================
${task}

=================== THE ENGINEER'S SUMMARY ===================
${neutralise(arm.run.finalResponse)}

=================== DIFF (${arm.diffStats.filesChanged} files, +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved}) ===================
${neutralise(diff)}
`;
}

export type ReviewOutput = { requirements: ReviewRequirement[]; waiversInForce: number[]; mergeable: boolean; summary: string; costUsd: number; model: string };

// Aligns the reviewer's answers to the fixed list and applies the waivers.
function alignRequirements(spec: ReviewSpec, answers: { index: number; status: "met" | "partial" | "unmet"; note: string }[]): ReviewRequirement[] {
  const waived = waivedIndices(spec);
  const byIndex = new Map(answers.map(a => [a.index - 1, a]));
  return spec.requirements.map((requirement, i) => {
    if (waived.has(i)) return { index: i, requirement, status: "waived" as const, note: spec.adjudications.find(a => a.index === i && a.waived)?.reason ?? "waived" };
    const a = byIndex.get(i);
    return a ? { index: i, requirement, status: a.status, note: a.note } : { index: i, requirement, status: "unmet" as const, note: "(not assessed by the reviewer)" };
  });
}

export const isMergeable = (requirements: ReviewRequirement[]) =>
  requirements.every(x => x.status === "met" || x.status === "waived");

export async function reviewDraft(task: string, arm: ArmResult, model: string, round: number, previous: ReviewPass | null, spec: ReviewSpec, disputed = ""): Promise<ReviewOutput | null> {
  log(`[${arm.condition}] Review round ${round}: checking requirements with ${model}…`);
  const res = await runStructured<{ requirements: { index: number; status: "met" | "partial" | "unmet"; note: string }[]; summary: string }>(`Review:${arm.condition}:${round}`, prompt(task, arm, round, previous, spec, disputed), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const requirements = alignRequirements(spec, res.data.requirements);
  const mergeable = isMergeable(requirements);
  log(`[${arm.condition}] Review round ${round}: ${mergeable ? "all requirements met" : "not yet"}; ${requirements.filter(r => r.status === "met").length} met / ${requirements.filter(r => r.status === "partial").length} partial / ${requirements.filter(r => r.status === "unmet").length} unmet / ${requirements.filter(r => r.status === "waived").length} waived; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { requirements, waiversInForce: [...waivedIndices(spec)].sort((a, b) => a - b), mergeable, summary: res.data.summary, costUsd: res.costUsd, model: res.modelUsed };
}

// ---- Disputes, adjudicated once for both arms -------------------------------

const DISPUTE_SCHEMA = {
  type: "object",
  properties: { decisions: { type: "array", items: { type: "object", properties: {
    index: { type: "integer" }, waive: { type: "boolean" }, reason: { type: "string" },
  }, required: ["index", "waive", "reason"] } } },
  required: ["decisions"],
};

// Decides the disputed requirements that have not been decided yet, and
// records the decisions on the shared spec. Blind to which arm disputed and
// to its diff: only the task, the list and the engineer's argument. Returns
// the call's cost.
export async function adjudicateDisputes(task: string, spec: ReviewSpec, disputed: string, by: Condition, round: number, model: string): Promise<number> {
  const open = spec.requirements.map((_, i) => i).filter(i => !spec.adjudications.some(a => a.index === i));
  if (!open.length || !disputed.trim()) return 0;
  log(`[${by}] Review round ${round}: the agent disputed part of the review; adjudicating with ${model}…`);
  const p = `A task was given to an engineer, whose pull request is being reviewed against the numbered requirements below. In their latest revision the engineer disputes part of the review. Decide, for each requirement their dispute addresses, whether to waive it. A waiver means the requirement does not apply to this task at all, for anyone. Waive only when the dispute shows the requirement is wrong for this codebase, contradicts another requirement, or would do harm if implemented. Do not waive because the engineer says it is already satisfied: you cannot see the diff, and the next check will re-verify that. "It is out of scope", "the wording does not fit" or "it can be a follow-up" are not grounds when the task states the requirement. Return one decision per requirement the dispute addresses (by number); leave the others out. reason ≤ 25 words. Your decision will bind every check of this task from now on.

=================== TASK ===================
${task}

=================== REQUIREMENTS ===================
${spec.requirements.map((r, i) => `${i + 1}. ${r}${open.includes(i) ? "" : "   (already decided)"}`).join("\n")}

=================== THE ENGINEER'S DISPUTE ===================
${neutralise(disputed)}
`;
  const res = await runStructured<{ decisions: { index: number; waive: boolean; reason: string }[] }>(`Adjudicate:${by}:${round}`, p, model, DISPUTE_SCHEMA, 5 * 60 * 1000, false);
  if (!res) return 0;
  for (const d of res.data.decisions) {
    const i = d.index - 1;
    if (!open.includes(i) || spec.adjudications.some(a => a.index === i)) continue;
    spec.adjudications.push({ index: i, waived: d.waive, reason: d.reason, disputedBy: by, round });
    log(`[${by}] Review round ${round}: requirement ${i + 1} "${spec.requirements[i]}" ${d.waive ? "WAIVED for both arms" : "dispute rejected"} — ${d.reason}`);
  }
  spec.costUsd += res.costUsd;
  return res.costUsd;
}

// Re-applies the final waivers to an arm's last review pass, so a waiver won
// by one arm after the other arm's last review shows for both. finalMergeable
// follows.
export function applyWaivers(arm: ArmResult, spec: ReviewSpec): void {
  const rv = arm.review;
  if (!rv || !rv.passes.length) return;
  const last = rv.passes[rv.passes.length - 1];
  const waived = waivedIndices(spec);
  for (const r of last.requirements) {
    if (r.index !== undefined && waived.has(r.index) && r.status !== "waived") {
      r.status = "waived";
      r.note = `waived for both arms: ${spec.adjudications.find(a => a.index === r.index && a.waived)?.reason ?? ""}`;
    }
  }
  last.mergeable = isMergeable(last.requirements);
  rv.finalMergeable = last.mergeable;
}

// The message the agent gets when its session is resumed for a fix pass:
// the requirements not yet met and why, nothing else.
export function fixPrompt(round: number, r: ReviewOutput): string {
  const open = r.requirements.filter(x => x.status === "unmet" || x.status === "partial").map(x => `- ${x.requirement} — ${x.status}: ${x.note}`).join("\n");
  return `Your change has been checked against the task's requirements (round ${round}). These are not yet met:
${open || "(none)"}

Make the change meet each of them. Do not take on work beyond what these requirements need. If you believe one is wrong — it does not apply to this codebase, is already satisfied in a way the check missed, or would do harm — do not silently ignore it: put a section headed "Disputed:" in your final response that names it and gives your reason, so it can be decided. Where you are unsure how the codebase handles something, research it with the tools you used before rather than guessing. Keep to the conventions you already followed. Re-run the checks you ran before and wait for them to finish. Do not rebase, commit, branch, or tidy unrelated files. End with a short summary of what changed.`;
}

// The "Disputed:" section of a fix-pass response, if any.
export function disputedSection(finalResponse: string): string {
  const m = finalResponse.match(/(?:^|\n)\s*(?:#+\s*)?\**Disputed:?\**\s*\n?([\s\S]{0,2000})/i);
  // The section ends at the next heading or bold title line, or a blank line
  // followed by a non-list line; without that, the summary that follows
  // would be sent to the adjudicator as part of the dispute.
  let text = m ? m[1] : "";
  const end = text.search(/\n\s*(#+\s|\*\*[^*\n]+\*\*:?\s*\n)|\n\s*\n(?![ \t]*[-*\d])/);
  if (end >= 0) text = text.slice(0, end);
  text = text.trim();
  // "Disputed: none." is not a dispute.
  return /^[\s*_]*(none|nothing|n\/a|no disputes?|no)\b/i.test(text) ? "" : text;
}
