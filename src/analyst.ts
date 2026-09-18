import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./util.ts";

// One way to ask a model for structured output: a single-turn `claude -p` call
// with no tools and no MCP, a JSON schema, redaction of strings that trip input
// safeguards, a retry on an intermittent decline, and a fallback model. Used by
// the per-turn attribution analyst and the quality judge.

const BINARY = process.env.CLAUDE_BINARY ?? "claude";
export const FALLBACK_MODEL = "opus";

// Shell commands that run tests, linters, type checks, builds or CI. Used to
// pick verification output for the judge and to classify tool wait. Broad on
// purpose: `gradlew`, `make lint-changes`, `bun test`, `detekt` all count.
export const VERIFY_CMD = /(\b(rspec|rails test|bin\/ci|npm (test|run [\w:-]*(test|lint|check|build)[\w:-]*)|pnpm (test|lint|build)|yarn (test|lint|build)|bun test|go (test|vet|build)|gofmt|rubocop|tsc|eslint|pytest|jest|vitest|cargo (test|build|clippy)|mvn|gradlew?|detekt|ktlint)\b|\bmake [\w-]*(test|lint|check|build|ci)[\w-]*\b)/;
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

interface RawOut { structured_output?: unknown; result?: string; total_cost_usd?: number; is_error?: boolean; stop_reason?: string; num_turns?: number; subtype?: string }

// HARNESS_DEBUG_DIR=<dir>: every analyst call's raw CLI output is written there.
const DEBUG_DIR = process.env.HARNESS_DEBUG_DIR;
let debugSeq = 0;

// Analyst calls run from an empty directory. With the harness as cwd, Claude
// Code loads this repo's CLAUDE.md into the model's system prompt, and the
// judge learns the experiment's premise ("with and without Unblocked").
const ANALYST_CWD = path.join(os.tmpdir(), "claude-harness-analyst");
fs.mkdirSync(ANALYST_CWD, { recursive: true });

function callOnce(prompt: string, model: string, schema: object, timeoutMs: number): { out: RawOut | null; declined: boolean; error: string } {
  // --max-turns 3, not 1: structured output is returned through a tool round
  // trip, and with 1 the CLI ends in error_max_turns before the JSON arrives.
  const args = [
    "-p", "--model", model, "--max-turns", "3", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--output-format", "json", "--json-schema", JSON.stringify(schema),
  ];
  const res = spawnSync(BINARY, args, { cwd: ANALYST_CWD, input: prompt, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs });
  if (DEBUG_DIR) {
    try {
      const base = `${DEBUG_DIR}/analyst-${Date.now()}-${++debugSeq}`;
      require("node:fs").writeFileSync(`${base}.prompt.txt`, prompt);
      require("node:fs").writeFileSync(`${base}.stdout.json`, res.stdout ?? "");
      require("node:fs").writeFileSync(`${base}.stderr.txt`, res.stderr ?? "");
    } catch {}
  }
  if (!res.stdout?.length) return { out: null, declined: false, error: `exit ${res.status}: ${(res.stderr ?? "").toString().slice(0, 300)}` };
  let out: RawOut;
  try { out = JSON.parse(res.stdout.toString()); } catch (err) { return { out: null, declined: false, error: `unparseable output: ${(err as Error).message}` }; }
  if (out.structured_output) return { out, declined: false, error: "" };
  const msg = String(out.result ?? "");
  const detail = `stop_reason=${out.stop_reason ?? "?"} subtype=${out.subtype ?? "?"} is_error=${out.is_error ?? "?"} turns=${out.num_turns ?? "?"} result="${msg.slice(0, 200)}"`;
  return { out, declined: /safeguards flagged/i.test(msg), error: detail };
}

// Runs the prompt and returns the schema-shaped result, or null after logging
// why. Cost includes declined attempts, which still bill. `redactInput` strips
// strings that have tripped input safeguards; leave it off when the caller
// needs them intact (the quality judge reads image digests and env names).
export function runStructured<T>(what: string, prompt: string, model: string, schema: object, timeoutMs = 15 * 60 * 1000, redactInput = true): StructuredResult<T> | null {
  const p = redactInput ? redact(prompt) : prompt;
  let cost = 0;
  let modelUsed = model;
  let r = callOnce(p, model, schema, timeoutMs);
  cost += r.out?.total_cost_usd ?? 0;
  for (let attempt = 1; !r.out?.structured_output && r.declined && attempt <= DECLINE_RETRIES; attempt++) {
    log(`${what}: ${model} declined the input (safeguards, intermittent); retry ${attempt}/${DECLINE_RETRIES}`);
    r = callOnce(p, model, schema, timeoutMs);
    cost += r.out?.total_cost_usd ?? 0;
  }
  if (!r.out?.structured_output && !r.declined) {
    log(`${what}: no structured output on first attempt (${r.error}); retrying once`);
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
