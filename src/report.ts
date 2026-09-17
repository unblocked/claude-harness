import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Met, ToolCall } from "./types.ts";
import { costAt, formatCost, formatDiffSummary, formatDuration, formatTokens, padLeft, padRight, priceFor, totalTokens, uncachedTokens } from "./util.ts";
import type { TokenUsage } from "./types.ts";

const W = 78;

function r(content: string): string {
  return "║" + padRight(content, W + 2) + "║";
}

function blank(): string {
  return "║" + " ".repeat(W + 2) + "║";
}

function divider(): string {
  return "╠" + "═".repeat(W + 2) + "╣";
}

// Shell commands that write files. Agents sometimes bypass Edit/Write and
// patch code through `python3 - <<'PY' ... write_text(...)`, `cat > f <<EOF`,
// `sed -i`, etc.; without this, such an arm shows "Edit: 0" beside a real diff.
// Deliberately narrow: an earlier, looser version matched `2>/dev/null` and
// `=>` inside grep patterns and flagged ~125 read-only commands across the
// saved transcripts. This one flags 16 of 701, all genuine.
const BASH_WRITE_RE = new RegExp([
  String.raw`(?:^|[\s;&|(])cat\s*>{1,2}\s*[^\s&|;>]+\s*<<`,                                                  // cat > file <<EOF
  String.raw`(?:python3?|ruby|node|perl)\s+-\s*<<[\s\S]*?(?:write_text\(|\.write\(|open\([^)]*["'][wa]|writeFileSync|File\.write|IO\.write)`, // inline script that writes
  String.raw`\bsed\s+(?:-[a-zA-Z]*\s+)*-i\b`,                                                               // sed -i
  String.raw`\bperl\s+-p?i\b`,
  String.raw`\btee\s+(?:-a\s+)?(?!/dev/)[\w./-]+`,                                                          // tee file
  String.raw`\bgit\s+apply\b`,
  String.raw`(?:^|[\s;&|])patch\s+(?:-p\d\s+)?[<\w]`,
  String.raw`(?:^|[^\w<>=&$])>{1,2}\s*(?!/dev/|&)['"]?[\w./~-]+`,                                             // echo x > file; not 2>, =>, >&, /dev/null
].join("|"), "m");

function bashWritesFiles(cmd: string): boolean {
  return BASH_WRITE_RE.test(cmd);
}

function toolCategory(tc: ToolCall): string {
  if (tc.isMcp) {
    return tc.mcpServer?.toLowerCase().includes("unblocked") ? "Unblocked" : `MCP:${tc.mcpServer}`;
  }
  if (tc.name === "Bash") {
    const cmd = (tc.args.command as string) ?? "";
    if (/^unblocked\s+/.test(cmd)) return "Unblocked";
    return bashWritesFiles(cmd) ? "Bash (writes files)" : "Bash";
  }
  return tc.name;
}

// Wall time covered by the given calls, as a union of their intervals: two
// parallel 30s calls are 30s of tool time, not 60s. Calls issued by subagents
// are skipped — the parent Agent call's interval already spans them.
function unionMs(calls: ToolCall[]): number {
  const spans = calls
    .filter(tc => !tc.nested && tc.timestamp > 0 && (tc.durationMs ?? 0) > 0)
    .map(tc => [tc.timestamp, tc.timestamp + (tc.durationMs as number)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, curStart = -1, curEnd = -1;
  for (const [s, e] of spans) {
    if (s > curEnd) { if (curEnd > curStart) total += curEnd - curStart; curStart = s; curEnd = e; }
    else if (e > curEnd) curEnd = e;
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export function toolTimeMs(arm: ArmResult): number {
  return unionMs(arm.run.toolCalls);
}

function hasTiming(arm: ArmResult): boolean {
  return arm.run.toolCalls.some(tc => (tc.durationMs ?? 0) > 0);
}

// Tool wall time inside core turns only (union, subagent calls excluded).
function coreToolTimeMs(arm: ArmResult): number {
  const a = arm.attribution;
  if (!a) return toolTimeMs(arm);
  const windows = a.turns.filter(t => t.label !== "housekeeping" && t.startMs > 0).map(t => [t.startMs, t.startMs + t.durationMs] as const);
  const inCore = (tc: ToolCall) => windows.some(([s, e]) => tc.timestamp >= s && tc.timestamp < e);
  return unionMs(arm.run.toolCalls.filter(inCore));
}

function coreModelTimeMs(arm: ArmResult): number {
  const a = arm.attribution;
  if (!a) return modelTimeMs(arm);
  return Math.max(0, a.core.durationMs - coreToolTimeMs(arm));
}

// Short description of what the housekeeping turns were, for the summary line.
function housekeepingKinds(arm: ArmResult): string {
  const a = arm.attribution;
  if (!a) return "";
  const kinds: Record<string, number> = {};
  for (const t of a.turns) {
    if (t.label !== "housekeeping") continue;
    const s = t.summary.toLowerCase();
    const k = /commit/.test(s) ? "commit" : /checkout -b|switch -c|branch/.test(s) ? "branch" : /git status|git diff --stat|git log|rev-parse/.test(s) ? "status checks"
      : /package-lock|lockfile|checkout --|checkout -- /.test(s) ? "lockfile revert" : /rm -rf|rm -f|rmdir|dist|coverage/.test(s) ? "artifact cleanup"
      : /rspec|bin\/ci|npm|go test|test:js/.test(s) ? "redundant rerun" : /thinking/.test(s) ? "thinking" : "other";
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  return Object.entries(kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ×${n}`).join(", ");
}

const MET_ICON: Record<Met, string> = { met: "✓", partial: "◐", unmet: "✗" };

// Files the agent changed without ever calling Edit/Write: everything went
// through shell commands (heredocs, sed, git). Worth a note next to the tool
// counts, where "Edit: 0" would otherwise read as "did nothing".
function shellOnlyEdits(arm: ArmResult): boolean {
  const editors = arm.run.toolCalls.filter(tc => ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tc.name)).length;
  return arm.diffStats.filesChanged > 0 && editors === 0;
}

// category -> wall time across that category's calls (ms), overlap-free.
function toolTimeBreakdown(toolCalls: ToolCall[]): Record<string, number> {
  const byCat: Record<string, ToolCall[]> = {};
  for (const tc of toolCalls) (byCat[toolCategory(tc)] ??= []).push(tc);
  return Object.fromEntries(Object.entries(byCat).map(([c, calls]) => [c, unionMs(calls)]));
}

function modelTimeMs(arm: ArmResult): number {
  return Math.max(0, arm.run.durationMs - toolTimeMs(arm));
}

// Unblocked calls are left out: they have their own section, and this list is
// meant to show where the *rest* of the wall time went (tests, CI, shell).
function slowestTools(toolCalls: ToolCall[], n: number): ToolCall[] {
  return [...toolCalls]
    .filter(tc => (tc.durationMs ?? 0) > 0 && toolCategory(tc) !== "Unblocked")
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, n);
}

function toolLabel(tc: ToolCall): string {
  if (tc.name === "Bash") return `Bash: ${((tc.args.command as string) ?? "").replace(/\s+/g, " ").slice(0, 90)}`;
  if (tc.isMcp) return `${toolCategory(tc)}: ${((tc.args.query as string) ?? (tc.args.url as string) ?? "").slice(0, 80)}`;
  const fp = (tc.args.file_path as string) ?? "";
  return fp ? `${tc.name}: ...${fp.slice(-60)}` : tc.name;
}



// category -> model label -> count. Calls without model info land under "".
function toolBreakdown(toolCalls: ToolCall[]): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const tc of toolCalls) {
    const category = toolCategory(tc);
    const model = tc.model ? modelLabel(tc.model) : "";
    const byModel = counts[category] ?? {};
    byModel[model] = (byModel[model] ?? 0) + 1;
    counts[category] = byModel;
  }
  return counts;
}

function toolTotal(byModel: Record<string, number> | undefined): number {
  return Object.values(byModel ?? {}).reduce((a, n) => a + n, 0);
}

// "claude-haiku-4-5-20251001" → "haiku-4-5"
function modelLabel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function modelEntries(usage: TokenUsage): [string, TokenUsage][] {
  return Object.entries(usage.byModel ?? {});
}

// path.basename can't split Windows paths on macOS/Linux, and transcripts may
// come from either platform.
function repoName(repoPath: string): string {
  return repoPath.split(/[\\/]+/).filter(Boolean).pop() ?? repoPath;
}

function pctChange(baseline: number, treatment: number): string {
  if (baseline === 0) return "N/A";
  const pct = ((treatment - baseline) / baseline) * 100;
  return `${pct >= 0 ? "+" : ""}${Math.round(pct)}%`;
}

function armSummary(label: string, arm: ArmResult): string[] {
  const u = arm.run.tokenUsage;
  const timedOut = arm.run.timedOut;
  const tokensAvail = totalTokens(u) > 0;
  return [
    `  ${padRight(label.toUpperCase() + (timedOut ? " [TIMED OUT]" : ""), 28)}Time        Cost     Output   Turns`,
    `  ${"─".repeat(W - 2)}`,
    `  ${padRight("Task", 28)}${padLeft(formatDuration(arm.run.durationMs), 10)}  ${padLeft(tokensAvail ? formatCost(arm.estimatedCost) : "N/A", 10)}  ${padLeft(tokensAvail ? formatTokens(u.outputTokens) : "N/A", 8)}  ${padLeft(String(arm.run.assistantTurns), 3)}`,
    ...(hasTiming(arm) ? [
      `  ${padRight("  model / tools", 28)}${padLeft(formatDuration(modelTimeMs(arm)), 10)} / ${padLeft(formatDuration(toolTimeMs(arm)), 10)}`,
    ] : []),
    ...(tokensAvail ? [
      `  ${padRight("Tokens in/out", 28)}${padLeft(formatTokens(u.inputTokens), 10)} / ${padLeft(formatTokens(u.outputTokens), 10)}`,
      `  ${padRight("  (cache r/w)", 28)}${padLeft(formatTokens(u.cacheReadTokens), 10)} / ${padLeft(formatTokens(u.cacheCreationTokens), 10)}`,
      ...modelEntries(u).map(([m, mu]) =>
        `  ${padRight(`  ${modelLabel(m)}`, 28)}${padLeft(formatTokens(uncachedTokens(mu)), 10)}  ${padLeft(formatTokens(mu.cacheReadTokens), 10)} cached  ${padLeft(formatCost(costAt(priceFor(m), mu)), 8)}`),
    ] : []),
    `  ${padRight("Tool calls", 28)}${padLeft(String(arm.run.toolCalls.length), 10)}  Unblocked: ${arm.unblockedCalls.length}${shellOnlyEdits(arm) ? "  (all edits via shell)" : ""}`,
    `  ${padRight("Diff", 28)}${formatDiffSummary(arm.diffStats)}`,
    ...(arm.attribution ? [
      `  ${padRight("Core work", 28)}${padLeft(formatDuration(arm.attribution.core.durationMs), 10)}  ${padLeft(formatCost(arm.attribution.core.costUsd), 10)}  ${padLeft(formatTokens(arm.attribution.core.outputTokens), 8)}  ${padLeft(String(arm.attribution.core.turns), 3)}`,
      `  ${padRight("Housekeeping", 28)}${padLeft(formatDuration(arm.attribution.housekeeping.durationMs), 10)}  ${padLeft(formatCost(arm.attribution.housekeeping.costUsd), 10)}  ${padLeft(formatTokens(arm.attribution.housekeeping.outputTokens), 8)}  ${padLeft(String(arm.attribution.housekeeping.turns), 3)}`,
    ] : []),
  ];
}

export function printReport(result: ComparisonResult): void {
  const b = result.baseline;
  const u = result.unblocked;

  const lines: string[] = [
    "",
    "╔" + "═".repeat(W + 2) + "╗",
    r("  CLAUDE HARNESS — COMPARISON"),
    divider(),
    r(`  Repo:     ${repoName(result.repo)}`),
    r(`  Branch:   ${result.branch}`),
    r(`  Model:    ${result.model}`),
    r(`  Task:     ${result.task.slice(0, 60)}${result.task.length > 60 ? "..." : ""}`),

    divider(),
    blank(),
    ...armSummary("Baseline (no Unblocked)", b).map(s => r(s)),

    blank(),
    ...armSummary("With Unblocked", u).map(s => r(s)),

    divider(),
    blank(),
    ...(b.attribution && u.attribution ? [
      r("  1 · CORE TASK WORK  (information gathering, coding, testing — housekeeping removed)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Cost", 28)}${padLeft(formatCost(b.attribution.core.costUsd), 10)}  →  ${padLeft(formatCost(u.attribution.core.costUsd), 10)}  (${pctChange(b.attribution.core.costUsd, u.attribution.core.costUsd)})`),
      r(`  ${padRight("Time", 28)}${padLeft(formatDuration(b.attribution.core.durationMs), 10)}  →  ${padLeft(formatDuration(u.attribution.core.durationMs), 10)}  (${pctChange(b.attribution.core.durationMs, u.attribution.core.durationMs)})`),
      r(`  ${padRight("  model time", 28)}${padLeft(formatDuration(coreModelTimeMs(b)), 10)}  →  ${padLeft(formatDuration(coreModelTimeMs(u)), 10)}  (${pctChange(coreModelTimeMs(b), coreModelTimeMs(u))})`),
      r(`  ${padRight("  tool time (tests, CI…)", 28)}${padLeft(formatDuration(coreToolTimeMs(b)), 10)}  →  ${padLeft(formatDuration(coreToolTimeMs(u)), 10)}  (${pctChange(coreToolTimeMs(b), coreToolTimeMs(u))})`),
      r(`  ${padRight("Output tokens", 28)}${padLeft(formatTokens(b.attribution.core.outputTokens), 10)}  →  ${padLeft(formatTokens(u.attribution.core.outputTokens), 10)}  (${pctChange(b.attribution.core.outputTokens, u.attribution.core.outputTokens)})`),
      r(`  ${padRight("Cache-read tokens", 28)}${padLeft(formatTokens(b.attribution.core.cacheReadTokens), 10)}  →  ${padLeft(formatTokens(u.attribution.core.cacheReadTokens), 10)}  (${pctChange(b.attribution.core.cacheReadTokens, u.attribution.core.cacheReadTokens)})`),
      r(`  ${padRight("Turns", 28)}${padLeft(String(b.attribution.core.turns), 10)}  →  ${padLeft(String(u.attribution.core.turns), 10)}  (${pctChange(b.attribution.core.turns, u.attribution.core.turns)})`),
      blank(),
      r("  2 · HOUSEKEEPING  (model habit: tidying, committing, redundant reruns — not context-driven)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Baseline", 28)}${padLeft(String(b.attribution.housekeeping.turns), 4)} turns  ${padLeft(formatCost(b.attribution.housekeeping.costUsd), 9)}  ${padLeft(formatDuration(b.attribution.housekeeping.durationMs), 8)}  ${housekeepingKinds(b).slice(0, 40)}`),
      r(`  ${padRight("Unblocked", 28)}${padLeft(String(u.attribution.housekeeping.turns), 4)} turns  ${padLeft(formatCost(u.attribution.housekeeping.costUsd), 9)}  ${padLeft(formatDuration(u.attribution.housekeeping.durationMs), 8)}  ${housekeepingKinds(u).slice(0, 40)}`),
      r(`  ${padRight("Raw totals (incl. hk)", 28)}${padLeft(formatCost(b.estimatedCost), 10)}  →  ${padLeft(formatCost(u.estimatedCost), 10)}   ${padLeft(formatDuration(b.run.durationMs), 8)} → ${formatDuration(u.run.durationMs)}`),
    ] : [
      r("  COMPARISON (raw; run with attribution for the core/housekeeping split)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Duration", 28)}${padLeft(formatDuration(b.run.durationMs), 10)}  →  ${padLeft(formatDuration(u.run.durationMs), 10)}  (${pctChange(b.run.durationMs, u.run.durationMs)})`),
      r(`  ${padRight("Est. Cost", 28)}${padLeft(formatCost(b.estimatedCost), 10)}  →  ${padLeft(formatCost(u.estimatedCost), 10)}  (${pctChange(b.estimatedCost, u.estimatedCost)})`),
      r(`  ${padRight("Output tokens", 28)}${padLeft(formatTokens(b.run.tokenUsage.outputTokens), 10)}  →  ${padLeft(formatTokens(u.run.tokenUsage.outputTokens), 10)}  (${pctChange(b.run.tokenUsage.outputTokens, u.run.tokenUsage.outputTokens)})`),
    ]),
    ...(result.quality ? [
      blank(),
      r("  3 · QUALITY  (blinded judge)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Verdict", 28)}${result.quality.verdict.better} (${result.quality.verdict.confidence} confidence)`),
      ...result.quality.criteria.map(c => r(`  ${padRight("  " + c.criterion, 28)}${padLeft(String(c.baseline.score), 10)}  →  ${padLeft(String(c.unblocked.score), 10)}  / 5`)),
      r(`  ${padRight("Requirements met", 28)}${padLeft(result.quality.requirements.filter(x => x.baseline.status === "met").length + "/" + result.quality.requirements.length, 10)}  →  ${padLeft(result.quality.requirements.filter(x => x.unblocked.status === "met").length + "/" + result.quality.requirements.length, 10)}`),
    ] : []),
  ];

  if (u.unblockedCalls.length > 0) {
    lines.push(blank());
    lines.push(r(`  UNBLOCKED CONTEXT (${u.unblockedCalls.length} calls)`));
    lines.push(r(`  ${"─".repeat(W - 2)}`));
    const byTool: Record<string, string[]> = {};
    for (const call of u.unblockedCalls) {
      const list = byTool[call.tool] ?? [];
      if (call.query) list.push(call.query);
      byTool[call.tool] = list;
    }
    for (const [tool, queries] of Object.entries(byTool)) {
      const preview = queries.slice(0, 2).map(q => `"${q.slice(0, 28)}"`).join(", ");
      lines.push(r(`  ${padRight(tool, 24)}${preview}`));
    }
  }

  lines.push(blank());
  lines.push(r(`  Total experiment time: ${formatDuration(result.totalDurationMs)}    Cost: ${formatCost(result.totalEstimatedCost)}`));
  lines.push("╚" + "═".repeat(W + 2) + "╝");
  lines.push("");

  console.log(lines.join("\n"));
}

export function writeJsonResult(result: ComparisonResult, outDir: string): void {
  const clean = {
    ...result,
    baseline: { ...result.baseline, diff: result.baseline.diff.slice(0, 100_000) },
    unblocked: { ...result.unblocked, diff: result.unblocked.diff.slice(0, 100_000) },
  };
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(clean, null, 2));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDiff(diff: string): string {
  if (!diff || diff.startsWith("(")) {
    return `<span style="color: var(--text-muted)">${escapeHtml(diff)}</span>`;
  }
  return diff.split("\n").map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith("+++") || line.startsWith("---")) return `<span class="diff-meta">${escaped}</span>`;
    if (line.startsWith("@@")) return `<span class="diff-hunk">${escaped}</span>`;
    if (line.startsWith("diff ")) return `<span class="diff-file">${escaped}</span>`;
    if (line.startsWith("+")) return `<span class="diff-add">${escaped}</span>`;
    if (line.startsWith("-")) return `<span class="diff-del">${escaped}</span>`;
    return escaped;
  }).join("\n");
}

function barWidth(value: number, max: number): number {
  return max === 0 ? 0 : Math.round((value / max) * 100);
}

export function writeHtmlReport(result: ComparisonResult, outDir: string): string {
  const b = result.baseline;
  const u = result.unblocked;
  const bTokens = totalTokens(b.run.tokenUsage);
  const uTokens = totalTokens(u.run.tokenUsage);
  const bHasTokens = totalTokens(b.run.tokenUsage) > 0;
  const uHasTokens = totalTokens(u.run.tokenUsage) > 0;

  const toolsB = toolBreakdown(b.run.toolCalls);
  const toolsU = toolBreakdown(u.run.toolCalls);
  const timeB = toolTimeBreakdown(b.run.toolCalls);
  const timeU = toolTimeBreakdown(u.run.toolCalls);
  const allTools = [...new Set([...Object.keys(toolsB), ...Object.keys(toolsU)])].sort();
  const hasToolTiming = hasTiming(b) || hasTiming(u);
  const hasAttr = !!(b.attribution && u.attribution);
  const timeCell = (ms: number | undefined) => ms ? formatDuration(ms) : `<span style="color: var(--text-muted)">–</span>`;

  const armModels = (tools: Record<string, Record<string, number>>) =>
    new Set(Object.values(tools).flatMap(byModel => Object.keys(byModel)));
  const bMultiModel = armModels(toolsB).size > 1;
  const uMultiModel = armModels(toolsU).size > 1;

  const toolCell = (byModel: Record<string, number> | undefined, multiModel: boolean) => {
    const total = toolTotal(byModel);
    if (total === 0 || !multiModel) return String(total);
    const split = Object.entries(byModel ?? {})
      .map(([m, n]) => `${escapeHtml(m || "unknown")} ${n}`)
      .join(" &middot; ");
    return `${total} <span style="color: var(--text-muted); font-size: 12px;">(${split})</span>`;
  };


  const heroCard = (label: string, bVal: number, uVal: number, fmt: (n: number) => string) => {
    const better = uVal < bVal;
    return `
    <div class="hero-card${better ? " positive" : " negative"}">
      <div class="hero-label">${label}</div>
      <div class="hero-value${better ? " positive" : " negative"}">${pctChange(bVal, uVal)}</div>
      <div class="hero-detail">${fmt(bVal)} &rarr; ${fmt(uVal)}</div>
    </div>`;
  };

  const housekeepingLedger = (label: string, arm: ArmResult) => {
    const rows = arm.attribution!.turns.filter(t => t.label === "housekeeping");
    if (!rows.length) return `<div class="arm-tokens" style="color: var(--text-muted);">${escapeHtml(label)}: no housekeeping turns</div>`;
    return `
      <div class="arm-section">
        <div class="arm-header"><span class="arm-name">${escapeHtml(label)}</span></div>
        <table class="tool-table">
          <thead><tr><th>Turn</th><th>Cost</th><th>Time</th><th>What it did</th><th>Why excluded</th></tr></thead>
          <tbody>${rows.map(t => `
          <tr>
            <td>${t.turn}</td><td>${formatCost(t.costUsd)}</td><td>${formatDuration(t.durationMs)}</td>
            <td style="font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 12px;">${escapeHtml(t.summary)}</td>
            <td style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.reason)}${t.repeatOf ? ` (repeats turn ${t.repeatOf})` : ""}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>`;
  };

  const toolCompareRows = allTools.map(tool => {
    const bCount = toolTotal(toolsB[tool]);
    const uCount = toolTotal(toolsU[tool]);
    const isUnblocked = tool === "Unblocked";
    return `
      <tr class="${isUnblocked ? "highlight-row" : ""}">
        <td>${escapeHtml(tool)}</td>
        <td>${toolCell(toolsB[tool], bMultiModel)}</td>
        <td>${toolCell(toolsU[tool], uMultiModel)}</td>
        <td>${uCount - bCount >= 0 ? "+" : ""}${uCount - bCount}</td>
        ${hasToolTiming ? `<td>${timeCell(timeB[tool])}</td><td>${timeCell(timeU[tool])}</td>` : ""}
      </tr>`;
  }).join("");

  // Headline numbers are core work when attribution exists; raw totals move to the footnote.
  const armCard = (label: string, arm: ArmResult, accent: boolean) => {
    const t = arm.run.tokenUsage;
    const has = totalTokens(t) > 0;
    const a = arm.attribution;
    const head = a
      ? { dur: a.core.durationMs, cost: a.core.costUsd, out: a.core.outputTokens, turns: a.core.turns, tag: "core" }
      : { dur: arm.run.durationMs, cost: arm.estimatedCost, out: t.outputTokens, turns: arm.run.assistantTurns, tag: "" };
    return `
    <div class="arm-section"${accent ? ` style="border-color: rgba(59, 130, 246, 0.3);"` : ""}>
      <div class="arm-header"${accent ? ` style="border-bottom-color: rgba(59, 130, 246, 0.2);"` : ""}>
        <span class="arm-name">${escapeHtml(label)}${arm.run.timedOut ? ` <span style="color: var(--yellow); font-size: 12px;">(TIMED OUT)</span>` : ""}</span>
        ${a ? `<span style="font-size: 12px; color: var(--text-muted);">core task work · raw incl. housekeeping: ${formatCost(arm.estimatedCost)}, ${formatDuration(arm.run.durationMs)}, ${formatTokens(t.outputTokens)} out</span>` : ""}
      </div>
      <div class="arm-meta">
        <div class="arm-stat"><div class="arm-stat-val">${formatDuration(head.dur)}</div><div class="arm-stat-label">${head.tag} Duration</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${has ? formatCost(head.cost) : "N/A"}</div><div class="arm-stat-label">${head.tag} Cost</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${has ? formatTokens(head.out) : "N/A"}</div><div class="arm-stat-label">${head.tag} Output Tokens</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${head.turns}</div><div class="arm-stat-label">${head.tag} ${a ? "Messages" : "Turns"}</div></div>
      </div>
      ${has ? `<div class="arm-tokens">
        ${a ? `Core cache read: <span>${formatTokens(a.core.cacheReadTokens)}</span> &nbsp; Housekeeping: <span>${a.housekeeping.turns} msgs, ${formatCost(a.housekeeping.costUsd)}, ${formatDuration(a.housekeeping.durationMs)}</span> &nbsp;` : ""}
        Raw &mdash; Fresh Input: <span>${formatTokens(t.inputTokens)}</span> &nbsp;
        Output: <span>${formatTokens(t.outputTokens)}</span> &nbsp;
        Cache Read: <span>${formatTokens(t.cacheReadTokens)}</span> &nbsp;
        Cache Write: <span>${formatTokens(t.cacheCreationTokens)}</span>
      </div>` : `<div class="arm-tokens" style="color: var(--text-muted);">Token data unavailable</div>`}
      <div class="arm-tokens">
        ${hasTiming(arm) ? `Model time: <span>${formatDuration(modelTimeMs(arm))}</span> &nbsp; Tool time: <span>${formatDuration(toolTimeMs(arm))}</span> &nbsp;` : ""}
        Diff: <span>${escapeHtml(formatDiffSummary(arm.diffStats))}</span>
      </div>
    </div>`;
  };

  const slowestRows = (arm: ArmResult) => slowestTools(arm.run.toolCalls, 5).map(tc => `
      <tr>
        <td>${formatDuration(tc.durationMs ?? 0)}</td>
        <td style="font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 12px;">${escapeHtml(toolLabel(tc))}</td>
      </tr>`).join("");

  const maxTime = Math.max(b.run.durationMs, u.run.durationMs, 1);
  const maxCost = Math.max(b.estimatedCost, u.estimatedCost, 0.0001);
  const maxTokens = Math.max(bTokens, uTokens, 1);
  const bOut = b.run.tokenUsage.outputTokens, uOut = u.run.tokenUsage.outputTokens;
  const bCache = b.run.tokenUsage.cacheReadTokens, uCache = u.run.tokenUsage.cacheReadTokens;
  const maxOut = Math.max(bOut, uOut, 1);
  const maxCache = Math.max(bCache, uCache, 1);
  const bModelMs = modelTimeMs(b), uModelMs = modelTimeMs(u);
  const bToolMs = toolTimeMs(b), uToolMs = toolTimeMs(u);

  // One head-to-head bar pair. Lower is better for every metric shown, so the
  // Unblocked bar is green when it is at or below baseline.
  const barPair = (label: string, bVal: number, uVal: number, max: number, fmt: (n: number) => string, note = "") => {
    const better = uVal <= bVal;
    return `
    <div class="comparison-row">
      <div class="comp-label">${label}${note ? `<div class="comp-note">${note}</div>` : ""}</div>
      <div class="bar-group">
        <div class="bar-row">
          <span class="bar-tag baseline">Baseline</span>
          <div class="bar-track"><div class="bar-fill baseline" style="width: ${barWidth(bVal, max)}%">${fmt(bVal)}</div></div>
        </div>
        <div class="bar-row">
          <span class="bar-tag ${better ? "better" : "worse"}">Unblocked</span>
          <div class="bar-track"><div class="bar-fill ${better ? "better" : "worse"}" style="width: ${barWidth(uVal, max)}%">${fmt(uVal)}</div></div>
        </div>
      </div>
    </div>`;
  };

  const timestamp = new Date().toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const perModelRows = (armName: string, arm: ArmResult) =>
    modelEntries(arm.run.tokenUsage).map(([m, mu]) => `
      <tr>
        <td>${escapeHtml(armName)}</td>
        <td>${escapeHtml(modelLabel(m))}</td>
        <td>${formatTokens(mu.inputTokens)}</td>
        <td>${formatTokens(mu.outputTokens)}</td>
        <td>${formatTokens(mu.cacheReadTokens)}</td>
        <td>${formatTokens(mu.cacheCreationTokens)}</td>
        <td>${formatCost(costAt(priceFor(m), mu))}</td>
      </tr>`).join("");
  const modelBreakdownRows = perModelRows("Baseline", b) + perModelRows("With Unblocked", u);

  const modelsUsed = [...new Set([
    ...modelEntries(b.run.tokenUsage).map(([m]) => m),
    ...modelEntries(u.run.tokenUsage).map(([m]) => m),
  ])];
  if (modelsUsed.length === 0) modelsUsed.push(result.model);
  const pricingRows = modelsUsed.map(m => {
    const p = priceFor(m);
    return `
      <tr>
        <td>${escapeHtml(modelLabel(m))}</td>
        <td>$${p.input.toFixed(2)}</td>
        <td>$${p.output.toFixed(2)}</td>
        <td>$${p.cacheRead.toFixed(2)}</td>
        <td>$${p.cacheWrite.toFixed(2)}</td>
      </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Harness — A/B Comparison</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-2: #1a1a26;
    --border: #2a2a3a;
    --text: #e4e4ed;
    --text-muted: #8888a0;
    --accent: #3b82f6;
    --accent-light: #93c5fd;
    --accent-glow: rgba(59, 130, 246, 0.15);
    --green: #22c55e;
    --green-bg: rgba(34, 197, 94, 0.1);
    --red: #ef4444;
    --yellow: #eab308;
    --blue: #3b82f6;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }

  .container { max-width: 1100px; margin: 0 auto; padding: 40px 24px; }

  .header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 12px;
  }
  .logo {
    width: 44px; height: 44px;
    background: linear-gradient(135deg, var(--accent), var(--accent-light));
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 22px; color: white;
  }
  .header h1 {
    font-size: 28px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--text), var(--accent-light));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 40px;
  }
  .brand-tag {
    display: inline-block;
    background: var(--accent-glow);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 6px;
    padding: 2px 10px;
    font-size: 12px;
    color: var(--accent-light);
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 40px;
  }
  .meta-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
    display: flex;
    justify-content: space-between;
  }
  .meta-key { color: var(--text-muted); font-size: 13px; }
  .meta-val { font-weight: 600; font-size: 13px; }

  .hero-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
    margin-bottom: 40px;
  }
  .hero-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .hero-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--accent), var(--accent-light));
  }
  .hero-card.positive::before {
    background: linear-gradient(90deg, var(--green), #4ade80);
  }
  .hero-card.negative::before {
    background: linear-gradient(90deg, var(--red), #f87171);
  }
  .hero-label {
    font-size: 13px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .hero-value {
    font-size: 48px;
    font-weight: 800;
    line-height: 1.1;
    margin-bottom: 6px;
  }
  .hero-value.positive { color: var(--green); }
  .hero-value.negative { color: var(--red); }
  .hero-value.neutral { color: var(--accent-light); }
  .hero-detail {
    font-size: 14px;
    color: var(--text-muted);
  }

  .section { margin-bottom: 40px; }
  .section-title {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section-title::before {
    content: '';
    width: 4px; height: 20px;
    background: var(--accent);
    border-radius: 2px;
  }

  .comparison-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .comp-label {
    font-size: 14px;
    color: var(--text-muted);
    text-align: right;
  }
  .comp-note { font-size: 11px; color: var(--text-muted); opacity: 0.7; line-height: 1.3; }
  .bar-group { display: flex; flex-direction: column; gap: 6px; }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .bar-tag {
    font-size: 11px;
    font-weight: 600;
    width: 70px;
    text-align: right;
    flex-shrink: 0;
  }
  .bar-tag.baseline { color: var(--text-muted); }
  .bar-tag.better { color: var(--green); }
  .bar-tag.worse { color: var(--red); }
  .bar-track {
    flex: 1;
    height: 28px;
    background: var(--surface-2);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }
  .bar-fill {
    height: 100%;
    border-radius: 6px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    transition: width 0.6s ease;
  }
  .bar-fill.baseline { background: rgba(136, 136, 160, 0.25); color: var(--text-muted); }
  .bar-fill.better { background: rgba(34, 197, 94, 0.3); color: var(--green); }
  .bar-fill.worse { background: rgba(239, 68, 68, 0.3); color: var(--red); }

  .arm-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  .arm-header {
    padding: 16px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }
  .arm-name {
    font-weight: 700;
    font-size: 15px;
  }
  .arm-meta {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--border);
  }
  .arm-stat {
    background: var(--surface);
    padding: 16px;
    text-align: center;
  }
  .arm-stat-val {
    font-size: 22px;
    font-weight: 800;
    margin-bottom: 2px;
  }
  .arm-stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .arm-tokens {
    padding: 16px 20px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 24px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .arm-tokens span { color: var(--text); font-weight: 600; }

  .tool-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .tool-table th { text-align: left; padding: 10px 16px; font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  .tool-table td { padding: 10px 16px; border-bottom: 1px solid rgba(42, 42, 58, 0.5); }
  .tool-table tr:last-child td { border-bottom: none; }
  .highlight-row td { background: rgba(59, 130, 246, 0.08); font-weight: 600; }
  .tool-table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; }

  .unblocked-grid { display: flex; flex-direction: column; gap: 8px; }
  .unblocked-card {
    background: var(--surface);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 10px;
    padding: 12px 16px;
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .unblocked-tool {
    font-size: 13px; font-weight: 700;
    color: var(--accent-light);
    background: var(--accent-glow);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 4px;
    padding: 2px 8px;
    flex-shrink: 0;
  }
  .unblocked-query { font-size: 13px; color: var(--text-muted); }

  .diff-summary {
    display: flex;
    gap: 16px;
    font-size: 14px;
    color: var(--text-muted);
    margin-bottom: 12px;
  }
  .diff-added { color: var(--green); font-weight: 600; }
  .diff-removed { color: var(--red); font-weight: 600; }
  .diff-block {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: auto;
    max-height: 600px;
  }
  .diff-block pre {
    margin: 0;
    padding: 16px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 12px;
    line-height: 1.5;
    tab-size: 4;
  }
  .diff-block code { white-space: pre; }
  .diff-file { color: var(--accent-light); font-weight: 700; }
  .diff-meta { color: var(--text-muted); }
  .diff-hunk { color: var(--blue); }
  .diff-add { color: var(--green); background: rgba(34, 197, 94, 0.08); display: inline-block; width: 100%; }
  .diff-del { color: var(--red); background: rgba(239, 68, 68, 0.08); display: inline-block; width: 100%; }

  .hero-3 { grid-template-columns: repeat(3, 1fr); }
  .section-note { font-size: 13px; color: var(--text-muted); margin: -8px 0 16px; line-height: 1.6; }
  .section-sub { font-size: 12px; font-weight: 500; color: var(--text-muted); margin-left: 8px; }
  .ledger { margin-top: 12px; }
  .ledger summary { cursor: pointer; font-size: 13px; color: var(--accent-light); padding: 6px 0; }
  .verdict { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; font-size: 14px; line-height: 1.6; }
  .verdict.positive { border-left-color: var(--green); }
  .verdict.negative { border-left-color: var(--red); }
  .verdict-head { font-weight: 700; font-size: 16px; margin-bottom: 6px; }
  .verdict-conf { font-weight: 500; font-size: 13px; color: var(--text-muted); }
  .met { font-weight: 700; font-size: 13px; }
  .met-met { color: var(--green); } .met-partial { color: var(--yellow); } .met-unmet { color: var(--red); }
  .score { font-weight: 700; }
  .evidence { font-size: 12px; color: var(--text-muted); margin-top: 3px; line-height: 1.5; }
  .findings { display: flex; flex-direction: column; gap: 8px; }
  .finding { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
  .finding-arm { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 8px; }
  .finding-arm.unblocked { color: var(--accent-light); } .finding-arm.baseline { color: var(--text-muted); }
  @media (max-width: 768px) { .hero-3 { grid-template-columns: 1fr; } }

  .footer {
    text-align: center;
    padding-top: 32px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 13px;
  }
  .footer a { color: var(--accent-light); text-decoration: none; }

  @media (max-width: 768px) {
    .hero-grid { grid-template-columns: 1fr; }
    .comparison-row { grid-template-columns: 1fr; }
    .comp-label { text-align: left; }
    .meta-grid { grid-template-columns: 1fr; }
    .arm-meta { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="logo">U</div>
    <h1>Claude Harness</h1>
  </div>
  <div class="subtitle">
    A/B Comparison &mdash; ${timestamp} &nbsp;
    <span class="brand-tag">Baseline vs Unblocked</span>
  </div>

  <div class="meta-grid">
    <div class="meta-item"><span class="meta-key">Repository</span><span class="meta-val">${escapeHtml(repoName(result.repo))}</span></div>
    <div class="meta-item"><span class="meta-key">Branch</span><span class="meta-val">${escapeHtml(result.branch)}</span></div>
    <div class="meta-item"><span class="meta-key">Model</span><span class="meta-val">${escapeHtml(result.model)}</span></div>
    <div class="meta-item"><span class="meta-key">Duration</span><span class="meta-val">${formatDuration(result.totalDurationMs)}</span></div>
  </div>

  <div class="section">
    <div class="section-title">Task</div>
    <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px;">
      <div style="font-size: 14px; line-height: 1.7;">${escapeHtml(result.task)}</div>
    </div>
  </div>

  ${hasAttr ? `
  <div class="section">
    <div class="section-title">1 · Core task work</div>
    <div class="section-note">Information gathering, writing code, running tests. The part of a run that context can influence and that repeats across runs. Housekeeping turns (section 2) are removed from both arms by the same rule.</div>
    <div class="hero-grid hero-3">
      ${heroCard("Cost", b.attribution!.core.costUsd, u.attribution!.core.costUsd, formatCost)}
      ${heroCard("Time", b.attribution!.core.durationMs, u.attribution!.core.durationMs, formatDuration)}
      ${heroCard("Output tokens", b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, formatTokens)}
    </div>
    ${barPair("Cost", b.attribution!.core.costUsd, u.attribution!.core.costUsd, maxCost, formatCost)}
    ${barPair("Model time", coreModelTimeMs(b), coreModelTimeMs(u), maxTime, formatDuration, "thinking + generation")}
    ${barPair("Tool time", coreToolTimeMs(b), coreToolTimeMs(u), maxTime, formatDuration, "tests, CI, MCP, shell")}
    ${barPair("Output tokens", b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, Math.max(b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, 1), formatTokens, "what the model wrote")}
    ${barPair("Cache-read tokens", b.attribution!.core.cacheReadTokens, u.attribution!.core.cacheReadTokens, Math.max(b.attribution!.core.cacheReadTokens, u.attribution!.core.cacheReadTokens, 1), formatTokens, "context re-read per turn; 2% of output price")}
    ${barPair("Turns", b.attribution!.core.turns, u.attribution!.core.turns, Math.max(b.attribution!.core.turns, u.attribution!.core.turns, 1), String)}
  </div>

  <div class="section">
    <div class="section-title">2 · Housekeeping <span class="section-sub">excluded from section 1</span></div>
    <div class="section-note">Turns the model chose on its own after or between task work: reverting lockfiles, deleting build artifacts, polling git status, branching, committing, re-running checks that already passed. Varies run to run and is not driven by context, so it is reported here rather than in the comparison. Labelled by ${escapeHtml(b.attribution!.analystModel)}; every excluded turn is listed below so the call can be checked.</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Arm</th><th>Turns</th><th>Cost</th><th>Time</th><th>What it was</th><th>Raw total incl. housekeeping</th></tr></thead>
        <tbody>
          <tr><td>Baseline</td><td>${b.attribution!.housekeeping.turns}</td><td>${formatCost(b.attribution!.housekeeping.costUsd)}</td><td>${formatDuration(b.attribution!.housekeeping.durationMs)}</td><td>${escapeHtml(housekeepingKinds(b)) || "–"}</td><td>${formatCost(b.estimatedCost)} · ${formatDuration(b.run.durationMs)}</td></tr>
          <tr><td>With Unblocked</td><td>${u.attribution!.housekeeping.turns}</td><td>${formatCost(u.attribution!.housekeeping.costUsd)}</td><td>${formatDuration(u.attribution!.housekeeping.durationMs)}</td><td>${escapeHtml(housekeepingKinds(u)) || "–"}</td><td>${formatCost(u.estimatedCost)} · ${formatDuration(u.run.durationMs)}</td></tr>
        </tbody>
      </table>
    </div>
    <details class="ledger"><summary>Excluded turns, with reasons</summary>
      ${housekeepingLedger("Baseline", b)}
      ${housekeepingLedger("With Unblocked", u)}
    </details>
  </div>` : `
  <div class="hero-grid">
    ${heroCard("Speed", b.run.durationMs, u.run.durationMs, formatDuration)}
    ${heroCard("Cost", b.estimatedCost, u.estimatedCost, formatCost)}
  </div>
  <div class="section">
    <div class="section-title">Head-to-Head (raw)</div>
    ${barPair("Duration", b.run.durationMs, u.run.durationMs, maxTime, formatDuration)}
    ${barPair("Est. Cost", b.estimatedCost, u.estimatedCost, maxCost, formatCost)}
    ${barPair("Output tokens", bOut, uOut, maxOut, formatTokens, "what the model wrote")}
    ${barPair("Cache-read tokens", bCache, uCache, maxCache, formatTokens, "context re-read per turn; 2% of output price")}
  </div>`}

  ${result.quality ? `
  <div class="section">
    <div class="section-title">3 · Quality analysis <span class="section-sub">blinded judge: ${escapeHtml(result.quality.judgeModel)}</span></div>
    <div class="section-note">The judge saw the task, each arm's final response, the tests it ran, and its diff, labelled A and B in random order. It did not know which arm had Unblocked.</div>
    <div class="verdict ${result.quality.verdict.better === "unblocked" ? "positive" : result.quality.verdict.better === "baseline" ? "negative" : ""}">
      <div class="verdict-head">Verdict: ${result.quality.verdict.better === "tie" ? "tie" : result.quality.verdict.better === "unblocked" ? "With Unblocked" : "Baseline"} <span class="verdict-conf">(${result.quality.verdict.confidence} confidence)</span></div>
      <div>${escapeHtml(result.quality.verdict.rationale)}</div>
    </div>
    <div class="tool-table-wrap" style="margin-bottom: 16px;">
      <table class="tool-table">
        <thead><tr><th>Requirement from the task</th><th>Baseline</th><th>With Unblocked</th></tr></thead>
        <tbody>${result.quality.requirements.map(rq => `
          <tr>
            <td>${escapeHtml(rq.requirement)}</td>
            <td><span class="met met-${rq.baseline.status}">${MET_ICON[rq.baseline.status]} ${rq.baseline.status}</span><div class="evidence">${escapeHtml(rq.baseline.evidence)}</div></td>
            <td><span class="met met-${rq.unblocked.status}">${MET_ICON[rq.unblocked.status]} ${rq.unblocked.status}</span><div class="evidence">${escapeHtml(rq.unblocked.evidence)}</div></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="tool-table-wrap" style="margin-bottom: 16px;">
      <table class="tool-table">
        <thead><tr><th>Criterion</th><th>Baseline</th><th>With Unblocked</th></tr></thead>
        <tbody>${result.quality.criteria.map(c => `
          <tr>
            <td>${escapeHtml(c.criterion)}</td>
            <td><span class="score">${c.baseline.score}/5</span><div class="evidence">${escapeHtml(c.baseline.rationale)}</div></td>
            <td><span class="score">${c.unblocked.score}/5</span><div class="evidence">${escapeHtml(c.unblocked.rationale)}</div></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${result.quality.findings.length ? `<div class="findings">${result.quality.findings.map(f => `
      <div class="finding"><span class="finding-arm ${f.arm}">${f.arm === "unblocked" ? "With Unblocked" : "Baseline"}</span> ${escapeHtml(f.finding)}<div class="evidence">${escapeHtml(f.evidence)}</div></div>`).join("")}</div>` : ""}
  </div>` : ""}

  <div class="section">
    <div class="section-title">Arm Details</div>

    ${armCard("Baseline", b, false)}
    ${armCard("With Unblocked", u, true)}
  </div>

  ${modelBreakdownRows ? `
  <div class="section">
    <div class="section-title">Per-Model Breakdown</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Arm</th><th>Model</th><th>Fresh Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Est. Cost</th></tr></thead>
        <tbody>${modelBreakdownRows}</tbody>
      </table>
    </div>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Pricing &mdash; $ per million tokens</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th></tr></thead>
        <tbody>${pricingRows}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Tool Usage Breakdown</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Tool</th><th>Baseline</th><th>Unblocked</th><th>Delta</th>${hasToolTiming ? `<th>Baseline time</th><th>Unblocked time</th>` : ""}</tr></thead>
        <tbody>${toolCompareRows}</tbody>
      </table>
    </div>
    ${[["Baseline", b], ["Unblocked", u]].filter(([, a]) => shellOnlyEdits(a as ArmResult)).map(([n, a]) => `
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">
      ${n} changed ${(a as ArmResult).diffStats.filesChanged} file${(a as ArmResult).diffStats.filesChanged === 1 ? "" : "s"} without any Edit/Write call — see "Bash (writes files)" for the shell commands that did it. The diff below is the ground truth.
    </div>`).join("")}
  </div>

  ${hasToolTiming ? `
  <div class="section">
    <div class="section-title">Slowest Tool Calls</div>
    <div class="hero-grid">
      <div class="tool-table-wrap">
        <table class="tool-table">
          <thead><tr><th colspan="2">Baseline</th></tr></thead>
          <tbody>${slowestRows(b)}</tbody>
        </table>
      </div>
      <div class="tool-table-wrap">
        <table class="tool-table">
          <thead><tr><th colspan="2">With Unblocked</th></tr></thead>
          <tbody>${slowestRows(u)}</tbody>
        </table>
      </div>
    </div>
  </div>` : ""}

  ${u.unblockedCalls.length > 0 ? `
  <div class="section">
    <div class="section-title">Unblocked Context Queries</div>
    <div class="unblocked-grid">
      ${u.unblockedCalls.map(c => `
        <div class="unblocked-card">
          <span class="unblocked-tool">${escapeHtml(c.tool)}</span>
          ${c.query ? `<span class="unblocked-query">${escapeHtml(c.query.slice(0, 200))}</span>` : ""}
        </div>
      `).join("")}
    </div>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Code Changes &mdash; Baseline</div>
    <div class="diff-summary">
      <span>${b.diffStats.filesChanged} files</span>
      <span class="diff-added">+${b.diffStats.linesAdded}</span>
      <span class="diff-removed">-${b.diffStats.linesRemoved}</span>
      ${b.diffStats.commits ? `<span>${b.diffStats.commits} commit${b.diffStats.commits === 1 ? "" : "s"} by agent (included)</span>` : ""}
      ${b.diffStats.truncated ? `<span>diff text truncated</span>` : ""}
    </div>
    <div class="diff-block"><pre><code>${formatDiff(b.diff)}</code></pre></div>
  </div>

  <div class="section">
    <div class="section-title">Code Changes &mdash; With Unblocked</div>
    <div class="diff-summary">
      <span>${u.diffStats.filesChanged} files</span>
      <span class="diff-added">+${u.diffStats.linesAdded}</span>
      <span class="diff-removed">-${u.diffStats.linesRemoved}</span>
      ${u.diffStats.commits ? `<span>${u.diffStats.commits} commit${u.diffStats.commits === 1 ? "" : "s"} by agent (included)</span>` : ""}
      ${u.diffStats.truncated ? `<span>diff text truncated</span>` : ""}
    </div>
    <div class="diff-block"><pre><code>${formatDiff(u.diff)}</code></pre></div>
  </div>

  <div class="footer">
    Generated by Claude Harness &mdash;
    <a href="https://getunblocked.com">Unblocked</a>
  </div>

</div>
</body>
</html>`;

  const htmlPath = path.join(outDir, "report.html");
  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}
