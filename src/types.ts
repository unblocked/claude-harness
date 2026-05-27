export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
  isMcp: boolean;
  mcpServer?: string;
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
}

export type Condition = "baseline" | "unblocked";

export interface ArmResult {
  condition: Condition;
  run: RunResult;
  diff: string;
  diffStats: DiffStats;
  unblockedCalls: UnblockedCall[];
  estimatedCost: number;
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
}
