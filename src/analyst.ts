import { spawnSync } from "node:child_process";
import { log } from "./util.ts";

// One way to ask a model for structured output: a single-turn `claude -p` call
// with no tools and no MCP, a JSON schema, redaction of strings that trip input
// safeguards, a retry on an intermittent decline, and a fallback model. Used by
// the per-turn attribution analyst and the quality judge.

const BINARY = process.env.CLAUDE_BINARY ?? "claude";
export const FALLBACK_MODEL = "opus";
const DECLINE_RETRIES = 2;

// Strings that have tripped input safeguards on real transcripts (auth headers,
// token env names, long hex ids). None carry signal for labelling or judging.
export function redact(s: string): string {
  return s
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b0{7,}\b/g, "<zero-sha>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(\w*(TOKEN|SECRET|PASSWORD|API_KEY)\w*)\b/g, "<credential-var>");
}

export interface StructuredResult<T> { data: T; costUsd: number; modelUsed: string }

interface RawOut { structured_output?: unknown; result?: string; total_cost_usd?: number; is_error?: boolean }

function callOnce(prompt: string, model: string, schema: object, timeoutMs: number): { out: RawOut | null; declined: boolean; error: string } {
  const args = [
    "-p", "--model", model, "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--output-format", "json", "--json-schema", JSON.stringify(schema),
  ];
  const res = spawnSync(BINARY, args, { input: prompt, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs });
  if (!res.stdout?.length) return { out: null, declined: false, error: `exit ${res.status}: ${(res.stderr ?? "").toString().slice(0, 300)}` };
  let out: RawOut;
  try { out = JSON.parse(res.stdout.toString()); } catch (err) { return { out: null, declined: false, error: `unparseable output: ${(err as Error).message}` }; }
  if (out.structured_output) return { out, declined: false, error: "" };
  const msg = String(out.result ?? "");
  return { out, declined: /safeguards flagged/i.test(msg), error: msg.slice(0, 200) };
}

// Runs the prompt (redacted) and returns the schema-shaped result, or null
// after logging why. Cost includes declined attempts, which still bill.
export function runStructured<T>(what: string, prompt: string, model: string, schema: object, timeoutMs = 15 * 60 * 1000): StructuredResult<T> | null {
  const p = redact(prompt);
  let cost = 0;
  let modelUsed = model;
  let r = callOnce(p, model, schema, timeoutMs);
  cost += r.out?.total_cost_usd ?? 0;
  for (let attempt = 1; !r.out?.structured_output && r.declined && attempt <= DECLINE_RETRIES; attempt++) {
    log(`${what}: ${model} declined the input (safeguards, intermittent); retry ${attempt}/${DECLINE_RETRIES}`);
    r = callOnce(p, model, schema, timeoutMs);
    cost += r.out?.total_cost_usd ?? 0;
  }
  if (!r.out?.structured_output && r.declined && model !== FALLBACK_MODEL) {
    log(`${what}: ${model} still declining; falling back to ${FALLBACK_MODEL}`);
    modelUsed = `${FALLBACK_MODEL} (${model} declined)`;
    r = callOnce(p, FALLBACK_MODEL, schema, timeoutMs);
    cost += r.out?.total_cost_usd ?? 0;
  }
  if (!r.out?.structured_output) {
    log(`${what}: no structured output: ${r.error}`);
    return null;
  }
  return { data: r.out.structured_output as T, costUsd: cost, modelUsed };
}
