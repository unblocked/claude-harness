export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  // Present on byModel entries when the CLI reported them: exact billed cost
  // and the thinking share of outputTokens.
  costUsd?: number;
  thinkingTokens?: number;
  byModel?: Record<string, TokenUsage>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
  // Wall time from tool_use to its tool_result; undefined if no result was seen.
  durationMs?: number;
  // Issued by a subagent (the event carried parent_tool_use_id). Counted as a
  // call, but excluded from tool-time so it isn't summed on top of the parent.
  nested?: boolean;
  isMcp: boolean;
  mcpServer?: string;
  model?: string;
}

export interface RunResult {
  // The CLI's own duration_ms for the session when it reported one, else the
  // harness wall time. Excludes process spawn and shutdown.
  durationMs: number;
  // Harness wall time from spawn to exit; durationMs plus process overhead.
  wallMs?: number;
  tokenUsage: TokenUsage;
  toolCalls: ToolCall[];
  // API messages on the main thread (unique message ids), not content blocks.
  assistantTurns: number;
  finalResponse: string;
  sessionId?: string;
  exitCode: number | null;
  timedOut: boolean;
  // Why the harness killed the process, if it did: a baseline that called
  // Unblocked, an Unblocked arm that never did within the deadline, or the
  // per-arm timeout. A killed run is not a finished comparison.
  killedReason?: string;
  jsonlPath: string;
  worktreePath: string;
  totalCostUsd: number | null;
  // True when any pass lacked a billed total and the rate table filled in.
  costEstimated?: boolean;
}

export interface UnblockedCall {
  tool: string;
  query?: string;
}

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  // Commits the agent made on top of the worktree base. The diff is taken
  // against the base commit, so committed work is included either way.
  commits: number;
  // True when the diff text was too large to keep; the counts above still hold.
  truncated?: boolean;
}

export type Condition = "baseline" | "unblocked";

export type TurnLabelKind = "work" | "verify" | "housekeeping";

export interface TurnLabel {
  turn: number;
  label: TurnLabelKind;
  // Turn this one redundantly repeats (e.g. a second CI run with no change in between), else null.
  repeatOf: number | null;
  reason: string;
}

export interface AttributionTotals {
  costUsd: number;
  inputTokens: number;   // fresh (uncached) input
  cacheWriteTokens: number;
  durationMs: number;    // modelMs + toolMs
  modelMs: number;       // generation incl. thinking
  toolMs: number;        // waiting on tool results
  stallMs: number;       // excluded from durationMs: machine sleep or API outage during a model wait
  turns: number;         // API messages
  outputTokens: number;
  cacheReadTokens: number;
}

export interface AttributedTurn extends TurnLabel {
  startMs: number;       // epoch ms the message's window starts (previous message's end); 0 if no timestamps
  costUsd: number;
  durationMs: number;
  modelMs: number;
  toolMs: number;
  stallMs: number;
  outputTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  cacheWriteTokens: number;
  summary: string;
}

// Per-turn labels from an analyst model plus the rollup. `core` is work +
// verify: the part of the run the treatment can influence and that repeats
// across runs. `housekeeping` is what the model chose to do on its own
// (tidying, committing, redundant reruns): variable, not treatment-driven,
// reported separately so it doesn't decide the comparison.
export interface Attribution {
  analystModel: string;
  analystCostUsd: number;
  // True when every message's output count came from the stream (recorded with
  // --include-partial-messages); false when shared out from the run total by content size.
  outputExact: boolean;
  raw: AttributionTotals;
  core: AttributionTotals;
  housekeeping: AttributionTotals;
  turns: AttributedTurn[];
}

export type Met = "met" | "partial" | "unmet";

export interface QualityRequirement {
  index?: number;        // position in ReviewSpec.requirements when the judge graded the shared list
  requirement: string;
  baseline: { status: Met; evidence: string };
  unblocked: { status: Met; evidence: string };
}

export interface QualityCriterion {
  criterion: string;
  baseline: { score: number; rationale: string };
  unblocked: { score: number; rationale: string };
}

// Blinded judgement of the two arms' output: requirements coverage, scored
// criteria, notable findings and a verdict. The judge sees arms as A and B in
// random order; the result is un-blinded before it is stored.
export interface QualityAssessment {
  judgeModel: string;
  judgeCostUsd: number;
  // Which arm was shown as "Agent A" (random per run), so a blinding failure can be audited.
  armA?: Condition;
  requirements: QualityRequirement[];
  criteria: QualityCriterion[];
  findings: { arm: Condition; finding: string; evidence: string }[];
  verdict: { better: Condition | "tie"; rationale: string };
}

// Deterministic decomposition of the cost/time/token deltas (src/economics.ts).
export interface EconomicsSide {
  costUsd: number; durationMs: number; modelMs: number; toolMs: number; messages: number;
  outputTokens: number; thinkingTokens: number; visibleTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; inputTokens: number; contextPerMessage: number;
  research: { calls: number; payloadTokens: number; carriedTokens: number };
  toolWait: Record<string, number>;
}
export interface EconomicsBreakdown {
  // "core" when both arms have attribution (housekeeping removed); "raw" when
  // either lacks it, so both sides are whole-run figures.
  basis: "core" | "raw";
  baseline: EconomicsSide;
  unblocked: EconomicsSide;
  cost: { deltaUsd: number; terms: { output: number; cacheRead: number; cacheWrite: number; input: number }; unexplainedUsd: number };
  cacheRead: { deltaTokens: number; researchCarriedTokens: number; contextPerMessageDelta: number; messagesDelta: number };
  output: { deltaTokens: number; thinkingDelta: number; visibleDelta: number };
  time: { deltaMs: number; modelDeltaMs: number; toolDeltaMs: number; toolWaitDelta: Record<string, number> };
}

// Un-blinded assessment of what the research context did (src/impact.ts).
export interface ContextImpact {
  model: string;
  costUsd: number;
  research: { turn: number; query: string; itemsReturned: number; itemsUsed: { item: string; use: string }[]; value: "decisive" | "useful" | "unused" | "misleading"; note: string }[];
  impact: {
    outcome: "better" | "worse" | "similar";          // the Unblocked arm's result vs baseline, per the blinded judge
    contextEffect: "helped" | "hurt" | "mixed" | "none"; // what the research context itself did to that result
    outcomeDriver: "context" | "agent" | "both";        // whether the outcome traces to the context or to the agent's own behaviour
    summary: string;
    whatWouldChange: string;
  };
  // Filled when the Unblocked outcome was worse: what the baseline found that
  // the Unblocked agent did not, how, and which failure mode the Unblocked side hit.
  loss?: {
    baselineFound: string;                       // "" when baseline found nothing Unblocked lacked
    howFound: "systematic search" | "chance" | "n/a";
    unblockedFailure: "context misled" | "stopped searching early" | "context absent, never looked elsewhere" | "unrelated to context" | "n/a";
    explanation: string;
  };
  // Why the arms' cost, time and token counts differ, grounded in EconomicsBreakdown.
  economics: { cost: string; time: string; tokens: string };
}

export interface ReviewComment { file: string; severity: "must-fix" | "should-fix" | "nit"; comment: string }

// `index` is the position in ReviewSpec.requirements; absent on results from
// before the list was shared.
export interface ReviewRequirement { index?: number; requirement: string; status: "met" | "partial" | "unmet" | "waived"; note: string }

// The task's requirements, extracted once per run and checked by every
// review of both arms. Disputes from either arm are adjudicated once, blind
// to the arm, and a waiver applies to both.
// A ruling on a disputed requirement. `waived`: the requirement does not
// apply at all. `excludes`: the requirement stands but does not cover the
// named case (for example "hidden reviews"); every later check of either
// arm reads it that way. Neither: the dispute was rejected.
export interface ReviewAdjudication { index: number; waived: boolean; excludes?: string; reason: string; disputedBy: Condition; round: number }
export interface ReviewSpec { model: string; costUsd: number; requirements: string[]; adjudications: ReviewAdjudication[] }

// One review pass and, if it was not mergeable, the fix pass that followed.
export interface ReviewPass {
  round: number;
  reviewModel: string;
  reviewCostUsd: number;
  mergeable: boolean;
  summary: string;
  requirements: ReviewRequirement[];
  // Indices waived (for both arms) at the time this check ran. A requirement
  // this arm fixed before it was waived cost it a round the other arm skipped.
  waiversInForce?: number[];
  comments?: ReviewComment[];   // pre-classifier reviewer only; the check no longer comments
  before: DiffStats;
  fix: { costUsd: number; durationMs: number; messages: number; exitCode: number | null; timedOut: boolean; disputed: string } | null;
}

// Simulated review-and-fix rounds (--review, capped by --max-review-rounds). The reviewer saw only
// this arm; each fix pass resumed the agent's own session. Stops when the
// reviewer calls the change mergeable (every requirement met or waived) or
// the round limit is reached.
export interface ReviewRound {
  maxRounds: number;
  passes: ReviewPass[];
  // Set when a check call itself failed (declined, timed out) in this round;
  // the loop stopped there, so the last pass may predate the last fix.
  checkFailed?: number;
  draft: { diffStats: DiffStats; costUsd: number; durationMs: number; messages: number };
  finalMergeable: boolean;
}

export interface ArmResult {
  condition: Condition;
  run: RunResult;
  diff: string;
  diffStats: DiffStats;
  unblockedCalls: UnblockedCall[];
  estimatedCost: number;
  attribution?: Attribution;
  review?: ReviewRound;
}

export interface ComparisonResult {
  repo: string;
  task: string;
  branch: string;
  model: string;
  baseline: ArmResult;
  unblocked: ArmResult;
  // Longest arm; arms run in parallel.
  totalDurationMs: number;
  // Both arms' billed cost. Analysis (attribution + judge) is separate.
  totalEstimatedCost: number;
  analysisCostUsd?: number;
  reviewSpec?: ReviewSpec;
  quality?: QualityAssessment;
  impact?: ContextImpact;
  economics?: EconomicsBreakdown;
}

export interface Config {
  repo: string;
  task: string;
  model: string;
  timeoutSeconds: number;
  branch: string;
  keepWorktrees: boolean;
  cliMode: boolean;
  // Analyst model for per-turn attribution; null disables all analysis passes.
  analystModel: string | null;
  // Model for the quality judge and context-impact passes.
  judgeModel: string;
  // Requirement check (review.ts): a classifier, so a cheaper model than the judge.
  checkerModel: string;
  // Cap on review-and-fix rounds per arm (0 = no review). Rounds stop early
  // once the reviewer finds every task requirement met or waived.
  reviewRounds: number;
}
