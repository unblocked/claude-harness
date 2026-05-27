export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

export function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  process.stderr.write(`[${timestamp}] ${message}\n`);
}

export function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length);
}

export function padLeft(str: string, width: number): string {
  return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

// Anthropic API per-token pricing ($/M tokens)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  "opus": { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  "sonnet": { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.00 },
  "haiku": { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.00 },
};

export interface TokenUsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function effectiveInputTokens(u: TokenUsageLike): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

export function totalTokens(u: TokenUsageLike): number {
  return effectiveInputTokens(u) + u.outputTokens;
}

export function estimateCost(model: string, u: TokenUsageLike): number {
  const p = PRICING[model] ?? PRICING["claude-sonnet-4-6"];
  return (u.inputTokens / 1_000_000) * p.input
    + (u.outputTokens / 1_000_000) * p.output
    + (u.cacheReadTokens / 1_000_000) * p.cacheRead
    + (u.cacheCreationTokens / 1_000_000) * p.cacheWrite;
}
