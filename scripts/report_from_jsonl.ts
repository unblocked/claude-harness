// Generate a comparison report from two existing stream-json transcripts.
// Usage: bun scripts/report_from_jsonl.ts <baseline.jsonl> <unblocked.jsonl> [result.json | model] [branch] [task] [--attribute[=model]] [--rejudge[=model]] [--impact[=model]]
// Token usage and tool calls are always re-parsed from the transcripts. The
// task prompt, branch, and code diffs are not recorded in stream-json output:
// pass the run's original result.json (third argument, detected by .json
// extension) to carry them over, or supply model/branch/task as arguments.
// Repo and model fall back to the transcript's init event.
import fs from "node:fs";
import path from "node:path";
import { parseStreamJson } from "../src/claude.ts";
import { printReport, writeHtmlReport, writeJsonResult } from "../src/report.ts";
import { estimateCost } from "../src/util.ts";
import { attribute } from "../src/attribution.ts";
import { assessQuality } from "../src/quality.ts";
import { assessImpact } from "../src/impact.ts";
import { economics } from "../src/economics.ts";
import type { ArmResult, ComparisonResult, Condition, UnblockedCall } from "../src/types.ts";

interface InitInfo { cwd?: string; model?: string }

function initInfo(jsonl: string): InitInfo {
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "system" && e?.subtype === "init" && (e.cwd || e.model)) {
        return { cwd: e.cwd, model: e.model };
      }
    } catch {}
  }
  return {};
}

// Worktrees live at <wt-root>/<repo>/<arm>-<hash>, so the repo name is the
// parent directory of the run cwd. Handles both / and \ separators.
function repoFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

// The CLI's duration_ms; for a transcript with no result event (killed run),
// the span of event timestamps.
function durationMs(jsonl: string): number {
  let first = NaN, last = NaN;
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "result" && typeof e.duration_ms === "number") return e.duration_ms;
      if (typeof e?.timestamp === "string") { const t = Date.parse(e.timestamp); if (Number.isNaN(first)) first = t; last = t; }
    } catch {}
  }
  return Number.isNaN(first) ? 0 : Math.max(0, last - first);
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

function arm(condition: Condition, file: string, model: string, orig?: ArmResult): ArmResult {
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
    diff: orig?.diff ?? "(not captured — generated from transcript)",
    diffStats: orig?.diffStats ?? { filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 },
    unblockedCalls: unblockedCalls(parsed.toolCalls),
    estimatedCost: cost,
    // Carried over unless --attribute recomputes it; the analyst call is the slow part.
    attribution: orig?.attribution,
  };
}

// --attribute[=model] recomputes per-message attribution; --rejudge re-runs the
// quality judge (same model, default opus). Only these flags are stripped from
// argv, so a "--flag" inside a free-text task argument survives.
// --attribute[=model] recomputes attribution (default opus); --rejudge[=model]
// re-runs the quality judge and --impact[=model] the context-impact pass
// (default fable). Only these flags are stripped from argv.
const KNOWN = /^--(attribute|rejudge|impact)(=.*)?$/;
const flagModel = (name: string, dflt: string) => { const f = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`)); return f ? (f.split("=")[1] || dflt) : null; };
const attrModel = flagModel("attribute", "opus");
const judgeModel = flagModel("rejudge", "fable");
const impactModel = flagModel("impact", "fable");
const [,, baseFile, ubFile, thirdArg, branchArg, ...taskArg] = process.argv.filter(a => !KNOWN.test(a));
const orig: ComparisonResult | undefined = thirdArg?.endsWith(".json")
  ? JSON.parse(fs.readFileSync(thirdArg, "utf8"))
  : undefined;
const modelArg = orig ? undefined : thirdArg;
const init = initInfo(fs.readFileSync(baseFile, "utf8"));
const model = orig?.model ?? modelArg ?? init.model ?? "claude-opus-4-8";
const branch = orig?.branch ?? branchArg ?? "(not recorded in transcripts)";
const task = orig?.task ?? (taskArg.join(" ") || "(task not recorded in transcripts)");
const repo = orig?.repo ?? repoFromCwd(init.cwd) ?? "(from transcripts)";
const baseline = arm("baseline", baseFile, model, orig?.baseline);
const unblocked = arm("unblocked", ubFile, model, orig?.unblocked);
if (attrModel) {
  for (const a of [baseline, unblocked]) {
    const attr = attribute(a.run.jsonlPath, task, a.run.totalCostUsd ?? a.estimatedCost, attrModel, a.condition);
    if (attr) a.attribution = attr;
  }
}

const result: ComparisonResult = {
  repo,
  task,
  branch,
  model,
  baseline,
  unblocked,
  totalDurationMs: Math.max(baseline.run.durationMs, unblocked.run.durationMs),
  totalEstimatedCost: baseline.estimatedCost + unblocked.estimatedCost,
};

// The judge and impact passes are the expensive, non-deterministic steps; a
// previous result from the supplied result.json is kept unless re-run is asked
// for, and a failed re-run keeps the previous result rather than dropping it.
if (judgeModel) result.quality = assessQuality(result, judgeModel) ?? orig?.quality;
else if (orig?.quality) result.quality = orig.quality;

result.economics = economics(result);
if (impactModel) result.impact = assessImpact(result, impactModel) ?? orig?.impact;
else if (orig?.impact) result.impact = orig.impact;

result.analysisCostUsd = (baseline.attribution?.analystCostUsd ?? 0) + (unblocked.attribution?.analystCostUsd ?? 0) + (result.quality?.judgeCostUsd ?? 0) + (result.impact?.costUsd ?? 0);

const outDir = path.join(process.cwd(), "results", "regenerated");
fs.mkdirSync(outDir, { recursive: true });
printReport(result);
writeJsonResult(result, outDir);
const htmlPath = writeHtmlReport(result, outDir);
console.log("HTML:", htmlPath);
