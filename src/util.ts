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
interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }

// Rates are only used for the cost-estimate FALLBACK (when the SDK does not
// emit total_cost_usd / per-model costUSD). Opus 4.8 and Haiku 4.5 rates were
// verified to the cent by solving against the SDK's reported costUSD on real
// runs. cacheRead = 0.1x input, cacheWrite = 1.25x input (standard ratios).
const OPUS_PRICE: ModelPrice = { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 };
const SONNET_PRICE: ModelPrice = { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 };
const HAIKU_PRICE: ModelPrice = { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 };

const PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-8": OPUS_PRICE,
  "opus": OPUS_PRICE,
  "claude-sonnet-4-6": SONNET_PRICE,
  "claude-sonnet-4-5": SONNET_PRICE,
  "sonnet": SONNET_PRICE,
  "claude-haiku-4-5": HAIKU_PRICE,
  "haiku": HAIKU_PRICE,
};

// Resolve pricing by exact id, then by model family keyword. The SDK emits
// fully-qualified ids (e.g. "claude-haiku-4-5-20251001") that won't match the
// table exactly, so fall back to the family before defaulting to Sonnet.
function priceFor(model: string): ModelPrice {
  if (PRICING[model]) return PRICING[model];
  const id = model.toLowerCase();
  if (id.includes("opus")) return OPUS_PRICE;
  if (id.includes("haiku")) return HAIKU_PRICE;
  if (id.includes("sonnet")) return SONNET_PRICE;
  return SONNET_PRICE;
}

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

function costAt(p: ModelPrice, u: TokenUsageLike): number {
  return (u.inputTokens / 1_000_000) * p.input
    + (u.outputTokens / 1_000_000) * p.output
    + (u.cacheReadTokens / 1_000_000) * p.cacheRead
    + (u.cacheCreationTokens / 1_000_000) * p.cacheWrite;
}

export function estimateCost(model: string, u: TokenUsageLike & { byModel?: Record<string, TokenUsageLike> }): number {
  if (u.byModel && Object.keys(u.byModel).length > 0) {
    let total = 0;
    for (const [m, mu] of Object.entries(u.byModel)) {
      total += costAt(priceFor(m), mu);
    }
    return total;
  }
  return costAt(priceFor(model), u);
}
