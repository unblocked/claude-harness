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

export interface AttributionTotals { costUsd: number; durationMs: number; turns: number }

// Per-turn labels from an analyst model plus the rollup. `throughTask` is the
// run with housekeeping turns removed: the number to compare arms on when the
// tail of tidying, committing and redundant reruns should not count.
export interface Attribution {
  analystModel: string;
  analystCostUsd: number;
  taskCompleteTurn: number;
  raw: AttributionTotals;
  throughTask: AttributionTotals;
  housekeeping: AttributionTotals;
  turns: (TurnLabel & { costUsd: number; durationMs: number; summary: string })[];
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
