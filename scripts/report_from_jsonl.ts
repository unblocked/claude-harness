// Generate a comparison report from two existing stream-json transcripts.
// Usage: bun scripts/report_from_jsonl.ts <baseline.jsonl> <unblocked.jsonl> [model]
import fs from "node:fs";
import path from "node:path";
import { parseStreamJson } from "../src/claude.ts";
import { printReport, writeHtmlReport, writeJsonResult } from "../src/report.ts";
import { estimateCost } from "../src/util.ts";
import type { ArmResult, ComparisonResult, Condition, UnblockedCall } from "../src/types.ts";

function durationMs(jsonl: string): number {
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e?.type === "result" && typeof e.duration_ms === "number") return e.duration_ms; } catch {}
  }
  return 0;
}

function unblockedCalls(toolCalls: { name: string; args: Record<string, unknown>; mcpServer?: string }[]): UnblockedCall[] {
  const out: UnblockedCall[] = [];
  for (const tc of toolCalls) {
    const isUb = tc.mcpServer?.toLowerCase().includes("unblocked") || tc.name.toLowerCase().includes("unblocked");
    if (isUb) {
      out.push({ tool: tc.name.split(/__|::/).pop() ?? tc.name, query: (tc.args.query as string) ?? (tc.args.url as string) ?? undefined });
    }
  }
  return out;
}

function arm(condition: Condition, file: string, model: string): ArmResult {
  const jsonl = fs.readFileSync(file, "utf8");
  const parsed = parseStreamJson(jsonl);
  const run = {
    durationMs: durationMs(jsonl),
    tokenUsage: parsed.tokenUsage,
    toolCalls: parsed.toolCalls,
    assistantTurns: parsed.assistantTurns,
    finalResponse: parsed.finalResponse,
    sessionId: parsed.sessionId,
    exitCode: 0,
    timedOut: false,
    jsonlPath: file,
    worktreePath: "(from transcript)",
    totalCostUsd: parsed.totalCostUsd,
  };
  const cost = run.totalCostUsd ?? estimateCost(model, run.tokenUsage);
  return {
    condition, run,
    diff: "(not captured — generated from transcript)",
    diffStats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
    unblockedCalls: unblockedCalls(parsed.toolCalls),
    estimatedCost: cost,
  };
}

const [,, baseFile, ubFile, modelArg] = process.argv;
const model = modelArg ?? "claude-opus-4-8";
const baseline = arm("baseline", baseFile, model);
const unblocked = arm("unblocked", ubFile, model);

const result: ComparisonResult = {
  repo: "(from transcripts)",
  task: "Regenerated from baseline.jsonl + unblocked.jsonl with corrected token accounting",
  branch: "n/a",
  model,
  baseline,
  unblocked,
  totalDurationMs: Math.max(baseline.run.durationMs, unblocked.run.durationMs),
  totalEstimatedCost: baseline.estimatedCost + unblocked.estimatedCost,
};

const outDir = path.join(process.cwd(), "results", "regenerated");
fs.mkdirSync(outDir, { recursive: true });
printReport(result);
writeJsonResult(result, outDir);
const htmlPath = writeHtmlReport(result, outDir);
console.log("HTML:", htmlPath);
