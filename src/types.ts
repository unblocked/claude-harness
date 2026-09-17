export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
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
  durationMs: number;
  tokenUsage: TokenUsage;
  toolCalls: ToolCall[];
  assistantTurns: number;
  finalResponse: string;
  sessionId?: string;
  exitCode: number | null;
  timedOut: boolean;
  jsonlPath: string;
  worktreePath: string;
  totalCostUsd: number | null;
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
  durationMs: number;
  turns: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface AttributedTurn extends TurnLabel {
  startMs: number;       // epoch ms of the assistant event; 0 if the transcript has no timestamps
  costUsd: number;
  durationMs: number;
  outputTokens: number;
  cacheReadTokens: number;
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
  taskCompleteTurn: number;
  raw: AttributionTotals;
  core: AttributionTotals;
  housekeeping: AttributionTotals;
  turns: AttributedTurn[];
}

export type Met = "met" | "partial" | "unmet";

export interface QualityRequirement {
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
  requirements: QualityRequirement[];
  criteria: QualityCriterion[];
  findings: { arm: Condition; finding: string; evidence: string }[];
  verdict: { better: Condition | "tie"; confidence: "low" | "medium" | "high"; rationale: string };
}

export interface ArmResult {
  condition: Condition;
  run: RunResult;
  diff: string;
  diffStats: DiffStats;
  unblockedCalls: UnblockedCall[];
  estimatedCost: number;
  attribution?: Attribution;
}

export interface ComparisonResult {
  repo: string;
  task: string;
  branch: string;
  model: string;
  baseline: ArmResult;
  unblocked: ArmResult;
  totalDurationMs: number;
  totalEstimatedCost: number;
  quality?: QualityAssessment;
}

export interface Config {
  repo: string;
  task: string;
  model: string;
  timeoutSeconds: number;
  branch: string;
  keepWorktrees: boolean;
  cliMode: boolean;
  // Analyst model for per-turn attribution; null disables the pass.
  analystModel: string | null;
}
