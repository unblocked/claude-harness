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
  durationMs: number;    // modelMs + toolMs
  modelMs: number;       // generation incl. thinking
  toolMs: number;        // waiting on tool results
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
  // Longest arm; arms run in parallel.
  totalDurationMs: number;
  // Both arms' billed cost. Analysis (attribution + judge) is separate.
  totalEstimatedCost: number;
  analysisCostUsd?: number;
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
