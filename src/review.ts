import type { ArmResult, ReviewComment } from "./types.ts";
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
    comments: { type: "array", items: { type: "object", properties: {
      file: { type: "string" },
      severity: { type: "string", enum: ["must-fix", "should-fix", "nit"] },
      comment: { type: "string" },
    }, required: ["file", "severity", "comment"] } },
    summary: { type: "string" },
  },
  required: ["comments", "summary"],
};

function prompt(task: string, arm: ArmResult): string {
  const diff = arm.diff.length > DIFF_BUDGET ? arm.diff.slice(0, DIFF_BUDGET) + "\n… (diff truncated)" : arm.diff;
  return `You are reviewing a pull request from an engineer on your team. You know the task they were given. You have their PR description (their final summary) and the diff. Review it the way a careful senior engineer reviews a colleague's PR before merge.

First, list to yourself every explicit requirement and acceptance criterion in the task, and check each against the diff and the description. A requirement that is unmet or only partly met is a must-fix comment.

Then leave at most 5 comments in total. Each names a file, a severity (must-fix: wrong, unsafe, or a task requirement not met; should-fix: a real gap a reviewer would block on; nit: optional), and says concretely what is wrong and what to do instead, in ≤ 40 words. Beyond the requirements, look for: claims in the description the diff does not support; behaviour that differs from what the task asked; wording or names that collide with existing ones; missing or weak tests; logging or error paths that stay silent; convention breaks against the rest of the diff's surroundings. Do not comment on style. Do not ask for work the task did not ask for. If every requirement is met and the PR is mergeable as is, return no comments and say so in the summary.

summary: ≤ 2 sentences, what the review found.

=================== TASK ===================
${task}

=================== PR DESCRIPTION (the engineer's final summary) ===================
${neutralise(arm.run.finalResponse)}

=================== DIFF (${arm.diffStats.filesChanged} files, +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved}) ===================
${neutralise(diff)}
`;
}

export function reviewDraft(task: string, arm: ArmResult, model: string): { comments: ReviewComment[]; summary: string; costUsd: number; model: string } | null {
  log(`[${arm.condition}] Review: reviewing draft with ${model}…`);
  const res = runStructured<{ comments: ReviewComment[]; summary: string }>(`Review:${arm.condition}`, prompt(task, arm), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  log(`[${arm.condition}] Review: ${res.data.comments.length} comment(s) (${res.data.comments.filter(c => c.severity === "must-fix").length} must-fix); ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { ...res.data, costUsd: res.costUsd, model: res.modelUsed };
}

// The message the agent gets when its session is resumed for the fix pass.
export function fixPrompt(comments: ReviewComment[], summary: string): string {
  const list = comments.map((c, i) => `${i + 1}. [${c.severity}] ${c.file}: ${c.comment}`).join("\n");
  return `A reviewer has looked at your change. Their summary: ${summary}

Their comments:
${list}

Address each comment: fix what should be fixed, and where you disagree with a comment, say why in your final response rather than silently ignoring it. Where a comment concerns a convention, prior art, or something you were unsure of, research it first with the tools you used before, rather than guessing. Keep to the conventions you already followed. Re-run the checks you ran before. Do not commit, branch, or tidy unrelated files. End with a short summary of what changed in response to the review.`;
}
