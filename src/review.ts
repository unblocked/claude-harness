import type { ArmResult, ReviewComment, ReviewPass, ReviewRequirement } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { runStructured } from "./analyst.ts";

// One simulated code review of an arm's draft. The reviewer sees only this
// arm — the task, its final response and its diff — never the other arm, so
// nothing one agent discovered can leak into the other's fix pass. Same
// reviewer model and rubric for both arms. The comments go back to the same
// agent session, which addresses them in the same worktree.

const DIFF_BUDGET = 60_000;

function neutralise(s: string): string {
  return s.replace(/unblocked/gi, "the research tool").replace(/context_research|context_get_urls|context_search_\w+/g, "research_tool");
}

const SCHEMA = {
  type: "object",
  properties: {
    requirements: { type: "array", items: { type: "object", properties: {
      requirement: { type: "string" },
      status: { type: "string", enum: ["met", "unmet", "waived"] },
      note: { type: "string" },
    }, required: ["requirement", "status", "note"] } },
    comments: { type: "array", items: { type: "object", properties: {
      file: { type: "string" },
      severity: { type: "string", enum: ["must-fix", "should-fix", "nit"] },
      comment: { type: "string" },
    }, required: ["file", "severity", "comment"] } },
    mergeable: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["requirements", "comments", "mergeable", "summary"],
};

function prompt(task: string, arm: ArmResult, round: number, previous: ReviewPass | null, disputed: string): string {
  const diff = arm.diff.length > DIFF_BUDGET ? arm.diff.slice(0, DIFF_BUDGET) + "\n… (diff truncated)" : arm.diff;
  const prior = previous ? `
This is review round ${round}. In round ${previous.round} you left these comments:
${previous.comments.map((c, i) => `${i + 1}. [${c.severity}] ${c.file}: ${c.comment}`).join("\n") || "(none)"}
and marked these requirements: ${previous.requirements.map(r => `"${r.requirement}" ${r.status}`).join("; ")}.
${disputed ? `The engineer disputes part of the review. Their words: """${disputed}""". If the dispute is right — the requirement is wrong for this codebase, already satisfied elsewhere, or would do harm — mark that requirement "waived" with the reason in its note, and do not repeat the comment. If the dispute is wrong, say why in a comment and keep the requirement unmet.` : ""}
Judge the current state, not the history. Do not re-raise a comment that has been addressed.` : "";
  return `You are reviewing a pull request from an engineer on your team. You know the task they were given. You have their PR description (their final summary) and the diff. Review it the way a careful senior engineer reviews a colleague's PR before merge.
${prior}
First, list every explicit requirement and acceptance criterion in the task, ≤ 10 words each, and mark each met, unmet, or waived (only when the engineer's dispute holds), with a note ≤ 15 words citing the diff or description.

Then leave at most 5 comments in total. Each names a file, a severity (must-fix: wrong, unsafe, or a task requirement not met; should-fix: a real gap a reviewer would block on; nit: optional), and says concretely what is wrong and what to do instead, in ≤ 40 words. Beyond the requirements, look for: claims in the description the diff does not support; behaviour that differs from what the task asked; wording or names that collide with existing ones; missing or weak tests; logging or error paths that stay silent; convention breaks against the rest of the diff's surroundings. Do not comment on style. Do not ask for work the task did not ask for: no rebases, no refactors of untouched code, no changes to unrelated files.

mergeable: true only when every requirement is met or waived and there is no must-fix comment.
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

export function reviewDraft(task: string, arm: ArmResult, model: string, round: number, previous: ReviewPass | null, disputed: string): ReviewOutput | null {
  log(`[${arm.condition}] Review round ${round}: reviewing with ${model}…`);
  const res = runStructured<{ requirements: ReviewRequirement[]; comments: ReviewComment[]; mergeable: boolean; summary: string }>(`Review:${arm.condition}:${round}`, prompt(task, arm, round, previous, disputed), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const d = res.data;
  log(`[${arm.condition}] Review round ${round}: ${d.mergeable ? "mergeable" : "not mergeable"}; requirements ${d.requirements.filter(r => r.status === "met").length} met / ${d.requirements.filter(r => r.status === "unmet").length} unmet / ${d.requirements.filter(r => r.status === "waived").length} waived; ${d.comments.length} comment(s), ${d.comments.filter(c => c.severity === "must-fix").length} must-fix; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { ...d, costUsd: res.costUsd, model: res.modelUsed };
}

// The message the agent gets when its session is resumed for a fix pass.
export function fixPrompt(round: number, r: ReviewOutput): string {
  const unmet = r.requirements.filter(x => x.status === "unmet").map(x => `- ${x.requirement}: ${x.note}`).join("\n");
  const list = r.comments.map((c, i) => `${i + 1}. [${c.severity}] ${c.file}: ${c.comment}`).join("\n");
  return `A reviewer has looked at your change (review round ${round}). Their summary: ${r.summary}

Requirements they consider not yet met:
${unmet || "(none)"}

Their comments:
${list || "(none)"}

Address each unmet requirement and each comment: fix what should be fixed. If you believe a requirement or comment is wrong — it does not apply to this codebase, is already satisfied in a way the reviewer missed, or would do harm — do not silently ignore it: put a section headed "Disputed:" in your final response that names it and gives your reason, so the next review can weigh it. Where a comment concerns a convention, prior art, or something you were unsure of, research it first with the tools you used before, rather than guessing. Keep to the conventions you already followed. Re-run the checks you ran before. Do not rebase, commit, branch, or tidy unrelated files. End with a short summary of what changed in response to the review.`;
}

// The "Disputed:" section of a fix-pass response, if any, for the next reviewer.
export function disputedSection(finalResponse: string): string {
  const m = finalResponse.match(/(?:^|\n)\s*(?:#+\s*)?\**Disputed:?\**\s*\n?([\s\S]{0,2000})/i);
  return m ? m[1].trim() : "";
}
