import type { ArmResult, Condition, ReviewComment, ReviewPass, ReviewRequirement, ReviewSpec } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { runStructured } from "./analyst.ts";
import { CRITERIA } from "./quality.ts";

// Simulated code review, held to one standard for both arms:
//
// - The requirements are extracted from the task once, before either arm
//   runs, and every review checks that same numbered list. A reviewer that
//   wrote its own list would hold the two arms to different wordings.
// - A reviewer never waives anything. If an agent disputes a requirement in
//   its fix pass, an arm-blind adjudicator (task, requirement list, dispute
//   text; no diff, no arm name) decides. A waiver applies to both arms, for
//   every later round and for the final table.
// - mergeable is derived: every requirement met or waived and no must-fix
//   comment. Not the reviewer's own flag.
//
// The reviewer sees only its own arm: the task, the agent's final response
// as the PR description, and the diff. Same rubric for both.

const DIFF_BUDGET = 60_000;

function neutralise(s: string): string {
  return s.replace(/unblocked/gi, "the research tool").replace(/context_research|context_get_urls|context_search_\w+/g, "research_tool");
}

// ---- Requirements, once per run --------------------------------------------

const SPEC_SCHEMA = {
  type: "object",
  properties: { requirements: { type: "array", items: { type: "string" } } },
  required: ["requirements"],
};

export function extractRequirements(task: string, model: string): ReviewSpec | null {
  log(`Review: extracting the task's requirements with ${model}…`);
  const prompt = `A pull request will be reviewed against this task. List every explicit requirement and acceptance criterion the task states, one per entry, ≤ 12 words each, in the order the task gives them. Include deliverables the task names (for example tests, a changelog entry) as their own entries. Do not add requirements the task does not state, and do not merge two criteria into one entry.

=================== TASK ===================
${task}
`;
  const res = runStructured<{ requirements: string[] }>("Requirements", prompt, model, SPEC_SCHEMA, 5 * 60 * 1000, false);
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
    comments: { type: "array", items: { type: "object", properties: {
      file: { type: "string" },
      severity: { type: "string", enum: ["must-fix", "should-fix", "nit"] },
      comment: { type: "string" },
    }, required: ["file", "severity", "comment"] } },
    summary: { type: "string" },
  },
  required: ["requirements", "comments", "summary"],
};

function prompt(task: string, arm: ArmResult, round: number, previous: ReviewPass | null, spec: ReviewSpec): string {
  const diff = arm.diff.length > DIFF_BUDGET ? arm.diff.slice(0, DIFF_BUDGET) + "\n… (diff truncated)" : arm.diff;
  const waived = waivedIndices(spec);
  const list = spec.requirements.map((r, i) => `${i + 1}. ${r}${waived.has(i) ? "   [WAIVED — do not check; report it as met]" : ""}`).join("\n");
  const waiverNotes = spec.adjudications.map(a => `- Requirement ${a.index + 1}: ${a.waived ? "waived" : "dispute rejected, still required"} — ${a.reason}`).join("\n");
  const prior = previous ? `
This is review round ${round}. In round ${previous.round} you left these comments:
${previous.comments.map((c, i) => `${i + 1}. [${c.severity}] ${c.file}: ${c.comment}`).join("\n") || "(none)"}
and marked these requirements: ${previous.requirements.map((r, i) => `${i + 1} ${r.status}`).join("; ")}.
Judge the current state, not the history. Do not re-raise a comment that has been addressed.` : "";
  return `You are reviewing a pull request from an engineer on your team. You know the task they were given. You have their PR description (their final summary) and the diff. Review it the way a careful senior engineer reviews a colleague's PR before merge.
${prior}
The requirements are fixed; check each one by number and mark it met, partial (delivered for some of the cases the task covers, not all) or unmet, with a note ≤ 15 words citing the diff or description. Only met counts for merge. You cannot waive a requirement: if the description argues one should not apply, mark it unmet and note the argument; disputes are decided elsewhere.
${list}
${waiverNotes ? `\nDecisions already made on disputes:\n${waiverNotes}\n` : ""}
Then leave at most 5 comments in total. Each names a file, a severity (must-fix: wrong, unsafe, or a task requirement not met; should-fix: a real gap a reviewer would block on; nit: optional), and says concretely what is wrong and what to do instead, in ≤ 40 words. Beyond the requirements, judge the change on the same criteria the final quality assessment will use:
${CRITERIA.map(c => `   - ${c.text}`).join("\n")}
Look for: claims in the description the diff does not support; behaviour that differs from what the task asked; wording or names that collide with existing ones; missing or weak tests; logging or error paths that stay silent; convention breaks against the rest of the diff's surroundings. Do not comment on style. Do not ask for work the task did not ask for: no rebases, no refactors of untouched code, no changes to unrelated files.

summary: ≤ 2 sentences, what the review found.

=================== TASK ===================
${task}

=================== PR DESCRIPTION (the engineer's final summary) ===================
${neutralise(arm.run.finalResponse)}

=================== DIFF (${arm.diffStats.filesChanged} files, +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved}) ===================
${neutralise(diff)}
`;
}

export type ReviewOutput = { requirements: ReviewRequirement[]; comments: ReviewComment[]; mergeable: boolean; summary: string; costUsd: number; model: string };

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

export const isMergeable = (requirements: ReviewRequirement[], comments: ReviewComment[]) =>
  requirements.every(x => x.status === "met" || x.status === "waived") && !comments.some(c => c.severity === "must-fix");

export function reviewDraft(task: string, arm: ArmResult, model: string, round: number, previous: ReviewPass | null, spec: ReviewSpec): ReviewOutput | null {
  log(`[${arm.condition}] Review round ${round}: reviewing with ${model}…`);
  const res = runStructured<{ requirements: { index: number; status: "met" | "partial" | "unmet"; note: string }[]; comments: ReviewComment[]; summary: string }>(`Review:${arm.condition}:${round}`, prompt(task, arm, round, previous, spec), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const requirements = alignRequirements(spec, res.data.requirements);
  const comments = res.data.comments.slice(0, 5);
  const mergeable = isMergeable(requirements, comments);
  log(`[${arm.condition}] Review round ${round}: ${mergeable ? "mergeable" : "not mergeable"}; requirements ${requirements.filter(r => r.status === "met").length} met / ${requirements.filter(r => r.status === "partial").length} partial / ${requirements.filter(r => r.status === "unmet").length} unmet / ${requirements.filter(r => r.status === "waived").length} waived; ${comments.length} comment(s), ${comments.filter(c => c.severity === "must-fix").length} must-fix; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { requirements, comments, mergeable, summary: res.data.summary, costUsd: res.costUsd, model: res.modelUsed };
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
export function adjudicateDisputes(task: string, spec: ReviewSpec, disputed: string, by: Condition, round: number, model: string): number {
  const open = spec.requirements.map((_, i) => i).filter(i => !spec.adjudications.some(a => a.index === i));
  if (!open.length || !disputed.trim()) return 0;
  log(`[${by}] Review round ${round}: the agent disputed part of the review; adjudicating with ${model}…`);
  const p = `A task was given to an engineer, whose pull request is being reviewed against the numbered requirements below. In their latest revision the engineer disputes part of the review. Decide, for each requirement their dispute addresses, whether to waive it. Waive only when the dispute shows the requirement is wrong for this codebase, is already satisfied in a way a reviewer reading the diff would miss, or would do harm if implemented. "It is out of scope", "the wording does not fit" or "it can be a follow-up" are not grounds when the task states the requirement. Return one decision per requirement the dispute addresses (by number); leave the others out. reason ≤ 25 words. Your decision will bind every reviewer of this task from now on.

=================== TASK ===================
${task}

=================== REQUIREMENTS ===================
${spec.requirements.map((r, i) => `${i + 1}. ${r}${open.includes(i) ? "" : "   (already decided)"}`).join("\n")}

=================== THE ENGINEER'S DISPUTE ===================
${neutralise(disputed)}
`;
  const res = runStructured<{ decisions: { index: number; waive: boolean; reason: string }[] }>(`Adjudicate:${by}:${round}`, p, model, DISPUTE_SCHEMA, 5 * 60 * 1000, false);
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
  last.mergeable = isMergeable(last.requirements, last.comments);
  rv.finalMergeable = last.mergeable;
}

// The message the agent gets when its session is resumed for a fix pass.
export function fixPrompt(round: number, r: ReviewOutput): string {
  const unmet = r.requirements.filter(x => x.status === "unmet" || x.status === "partial").map(x => `- ${x.requirement}${x.status === "partial" ? " (partly)" : ""}: ${x.note}`).join("\n");
  const list = r.comments.map((c, i) => `${i + 1}. [${c.severity}] ${c.file}: ${c.comment}`).join("\n");
  return `A reviewer has looked at your change (review round ${round}). Their summary: ${r.summary}

Requirements they consider not yet met:
${unmet || "(none)"}

Their comments:
${list || "(none)"}

Address each unmet requirement and each comment: fix what should be fixed. If you believe a requirement or comment is wrong — it does not apply to this codebase, is already satisfied in a way the reviewer missed, or would do harm — do not silently ignore it: put a section headed "Disputed:" in your final response that names it and gives your reason, so it can be decided. Where a comment concerns a convention, prior art, or something you were unsure of, research it first with the tools you used before, rather than guessing. Keep to the conventions you already followed. Re-run the checks you ran before and wait for them to finish. Do not rebase, commit, branch, or tidy unrelated files. End with a short summary of what changed in response to the review.`;
}

// The "Disputed:" section of a fix-pass response, if any.
export function disputedSection(finalResponse: string): string {
  const m = finalResponse.match(/(?:^|\n)\s*(?:#+\s*)?\**Disputed:?\**\s*\n?([\s\S]{0,2000})/i);
  return m ? m[1].trim() : "";
}
