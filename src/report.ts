import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, ToolCall } from "./types.ts";
import { effectiveInputTokens, formatCost, formatDuration, formatTokens, padLeft, padRight, totalTokens } from "./util.ts";

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

function toolBreakdown(toolCalls: ToolCall[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tc of toolCalls) {
    let category: string;
    if (tc.isMcp) {
      category = tc.mcpServer?.toLowerCase().includes("unblocked") ? "Unblocked" : `MCP:${tc.mcpServer}`;
    } else if (tc.name === "Bash") {
      const cmd = (tc.args.command as string) ?? "";
      if (/^unblocked\s+/.test(cmd)) {
        category = "Unblocked";
      } else {
        category = "Bash";
      }
    } else {
      category = tc.name;
    }
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

function pctChange(baseline: number, treatment: number): string {
  if (baseline === 0) return "N/A";
  const pct = ((treatment - baseline) / baseline) * 100;
  return `${pct >= 0 ? "+" : ""}${Math.round(pct)}%`;
}

function armSummary(label: string, arm: ArmResult): string[] {
  const u = arm.run.tokenUsage;
  const total = totalTokens(u);
  const effIn = effectiveInputTokens(u);
  const timedOut = arm.run.timedOut;
  const tokensAvail = total > 0;
  return [
    `  ${padRight(label.toUpperCase() + (timedOut ? " [TIMED OUT]" : ""), 28)}Time        Cost     Tokens   Turns`,
    `  ${"─".repeat(W - 2)}`,
    `  ${padRight("Task", 28)}${padLeft(formatDuration(arm.run.durationMs), 10)}  ${padLeft(tokensAvail ? formatCost(arm.estimatedCost) : "N/A", 10)}  ${padLeft(tokensAvail ? formatTokens(total) : "N/A", 8)}  ${padLeft(String(arm.run.assistantTurns), 3)}`,
    ...(tokensAvail ? [
      `  ${padRight("Tokens in/out", 28)}${padLeft(formatTokens(effIn), 10)} / ${padLeft(formatTokens(u.outputTokens), 10)}`,
      `  ${padRight("  (cache r/w)", 28)}${padLeft(formatTokens(u.cacheReadTokens), 10)} / ${padLeft(formatTokens(u.cacheCreationTokens), 10)}`,
    ] : []),
    `  ${padRight("Tool calls", 28)}${padLeft(String(arm.run.toolCalls.length), 10)}  Unblocked: ${arm.unblockedCalls.length}`,
    `  ${padRight("Diff", 28)}${padLeft(String(arm.diffStats.filesChanged) + " files", 10)}  +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved}`,
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
    r(`  Repo:     ${path.basename(result.repo)}`),
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
    r("  COMPARISON"),
    r(`  ${"─".repeat(W - 2)}`),
    r(`  ${padRight("Duration", 28)}${padLeft(formatDuration(b.run.durationMs), 10)}  →  ${padLeft(formatDuration(u.run.durationMs), 10)}  (${pctChange(b.run.durationMs, u.run.durationMs)})`),
    r(`  ${padRight("Tokens", 28)}${padLeft(formatTokens(totalTokens(b.run.tokenUsage)), 10)}  →  ${padLeft(formatTokens(totalTokens(u.run.tokenUsage)), 10)}  (${pctChange(totalTokens(b.run.tokenUsage), totalTokens(u.run.tokenUsage))})`),
    r(`  ${padRight("Est. Cost", 28)}${padLeft(formatCost(b.estimatedCost), 10)}  →  ${padLeft(formatCost(u.estimatedCost), 10)}  (${pctChange(b.estimatedCost, u.estimatedCost)})`),
    r(`  ${padRight("Tool calls", 28)}${padLeft(String(b.run.toolCalls.length), 10)}  →  ${padLeft(String(u.run.toolCalls.length), 10)}  (${pctChange(b.run.toolCalls.length, u.run.toolCalls.length)})`),
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
  if (!diff || diff === "(no changes)" || diff === "(failed to capture diff)") {
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
  const bHasTokens = bTokens > 0;
  const uHasTokens = uTokens > 0;

  const toolsB = toolBreakdown(b.run.toolCalls);
  const toolsU = toolBreakdown(u.run.toolCalls);
  const allTools = [...new Set([...Object.keys(toolsB), ...Object.keys(toolsU)])].sort();

  const toolCompareRows = allTools.map(tool => {
    const bCount = toolsB[tool] ?? 0;
    const uCount = toolsU[tool] ?? 0;
    const isUnblocked = tool === "Unblocked";
    return `
      <tr class="${isUnblocked ? "highlight-row" : ""}">
        <td>${escapeHtml(tool)}</td>
        <td>${bCount}</td>
        <td>${uCount}</td>
        <td>${uCount - bCount >= 0 ? "+" : ""}${uCount - bCount}</td>
      </tr>`;
  }).join("");

  const maxTime = Math.max(b.run.durationMs, u.run.durationMs, 1);
  const maxCost = Math.max(b.estimatedCost, u.estimatedCost, 0.0001);
  const maxTokens = Math.max(bTokens, uTokens, 1);

  const timestamp = new Date().toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

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
    <div class="meta-item"><span class="meta-key">Repository</span><span class="meta-val">${escapeHtml(path.basename(result.repo))}</span></div>
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

  <div class="hero-grid">
    <div class="hero-card${u.run.durationMs < b.run.durationMs ? " positive" : " negative"}">
      <div class="hero-label">Speed</div>
      <div class="hero-value${u.run.durationMs < b.run.durationMs ? " positive" : " negative"}">
        ${pctChange(b.run.durationMs, u.run.durationMs)}
      </div>
      <div class="hero-detail">${formatDuration(b.run.durationMs)} &rarr; ${formatDuration(u.run.durationMs)}</div>
    </div>
    <div class="hero-card${u.estimatedCost < b.estimatedCost ? " positive" : " negative"}">
      <div class="hero-label">Cost</div>
      <div class="hero-value${u.estimatedCost < b.estimatedCost ? " positive" : " negative"}">
        ${pctChange(b.estimatedCost, u.estimatedCost)}
      </div>
      <div class="hero-detail">${formatCost(b.estimatedCost)} &rarr; ${formatCost(u.estimatedCost)}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Head-to-Head</div>
    <div class="comparison-row">
      <div class="comp-label">Duration</div>
      <div class="bar-group">
        <div class="bar-row">
          <span class="bar-tag baseline">Baseline</span>
          <div class="bar-track"><div class="bar-fill baseline" style="width: ${barWidth(b.run.durationMs, maxTime)}%">${formatDuration(b.run.durationMs)}</div></div>
        </div>
        <div class="bar-row">
          <span class="bar-tag ${u.run.durationMs <= b.run.durationMs ? "better" : "worse"}">Unblocked</span>
          <div class="bar-track"><div class="bar-fill ${u.run.durationMs <= b.run.durationMs ? "better" : "worse"}" style="width: ${barWidth(u.run.durationMs, maxTime)}%">${formatDuration(u.run.durationMs)}</div></div>
        </div>
      </div>
    </div>
    <div class="comparison-row">
      <div class="comp-label">Tokens</div>
      <div class="bar-group">
        <div class="bar-row">
          <span class="bar-tag baseline">Baseline</span>
          <div class="bar-track"><div class="bar-fill baseline" style="width: ${barWidth(bTokens, maxTokens)}%">${formatTokens(bTokens)}</div></div>
        </div>
        <div class="bar-row">
          <span class="bar-tag ${uTokens <= bTokens ? "better" : "worse"}">Unblocked</span>
          <div class="bar-track"><div class="bar-fill ${uTokens <= bTokens ? "better" : "worse"}" style="width: ${barWidth(uTokens, maxTokens)}%">${formatTokens(uTokens)}</div></div>
        </div>
      </div>
    </div>
    <div class="comparison-row">
      <div class="comp-label">Est. Cost</div>
      <div class="bar-group">
        <div class="bar-row">
          <span class="bar-tag baseline">Baseline</span>
          <div class="bar-track"><div class="bar-fill baseline" style="width: ${barWidth(b.estimatedCost, maxCost)}%">${formatCost(b.estimatedCost)}</div></div>
        </div>
        <div class="bar-row">
          <span class="bar-tag ${u.estimatedCost <= b.estimatedCost ? "better" : "worse"}">Unblocked</span>
          <div class="bar-track"><div class="bar-fill ${u.estimatedCost <= b.estimatedCost ? "better" : "worse"}" style="width: ${barWidth(u.estimatedCost, maxCost)}%">${formatCost(u.estimatedCost)}</div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Arm Details</div>

    <div class="arm-section">
      <div class="arm-header">
        <span class="arm-name">Baseline${b.run.timedOut ? ` <span style="color: var(--yellow); font-size: 12px;">(TIMED OUT)</span>` : ""}</span>
      </div>
      <div class="arm-meta">
        <div class="arm-stat"><div class="arm-stat-val">${formatDuration(b.run.durationMs)}</div><div class="arm-stat-label">Duration</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${bHasTokens ? formatCost(b.estimatedCost) : "N/A"}</div><div class="arm-stat-label">Est. Cost</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${bHasTokens ? formatTokens(bTokens) : "N/A"}</div><div class="arm-stat-label">Tokens</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${b.run.assistantTurns}</div><div class="arm-stat-label">Turns</div></div>
      </div>
      ${bHasTokens ? `<div class="arm-tokens">
        Input: <span>${formatTokens(effectiveInputTokens(b.run.tokenUsage))}</span> &nbsp;
        Output: <span>${formatTokens(b.run.tokenUsage.outputTokens)}</span> &nbsp;
        Cache Read: <span>${formatTokens(b.run.tokenUsage.cacheReadTokens)}</span> &nbsp;
        Cache Write: <span>${formatTokens(b.run.tokenUsage.cacheCreationTokens)}</span>
      </div>` : `<div class="arm-tokens" style="color: var(--text-muted);">Token data unavailable</div>`}
    </div>

    <div class="arm-section" style="border-color: rgba(59, 130, 246, 0.3);">
      <div class="arm-header" style="border-bottom-color: rgba(59, 130, 246, 0.2);">
        <span class="arm-name">With Unblocked${u.run.timedOut ? ` <span style="color: var(--yellow); font-size: 12px;">(TIMED OUT)</span>` : ""}</span>
      </div>
      <div class="arm-meta">
        <div class="arm-stat"><div class="arm-stat-val">${formatDuration(u.run.durationMs)}</div><div class="arm-stat-label">Duration</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${uHasTokens ? formatCost(u.estimatedCost) : "N/A"}</div><div class="arm-stat-label">Est. Cost</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${uHasTokens ? formatTokens(uTokens) : "N/A"}</div><div class="arm-stat-label">Tokens</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${u.run.assistantTurns}</div><div class="arm-stat-label">Turns</div></div>
      </div>
      ${uHasTokens ? `<div class="arm-tokens">
        Input: <span>${formatTokens(effectiveInputTokens(u.run.tokenUsage))}</span> &nbsp;
        Output: <span>${formatTokens(u.run.tokenUsage.outputTokens)}</span> &nbsp;
        Cache Read: <span>${formatTokens(u.run.tokenUsage.cacheReadTokens)}</span> &nbsp;
        Cache Write: <span>${formatTokens(u.run.tokenUsage.cacheCreationTokens)}</span>
      </div>` : `<div class="arm-tokens" style="color: var(--text-muted);">Token data unavailable</div>`}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Tool Usage Breakdown</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Tool</th><th>Baseline</th><th>Unblocked</th><th>Delta</th></tr></thead>
        <tbody>${toolCompareRows}</tbody>
      </table>
    </div>
  </div>

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
    </div>
    <div class="diff-block"><pre><code>${formatDiff(b.diff)}</code></pre></div>
  </div>

  <div class="section">
    <div class="section-title">Code Changes &mdash; With Unblocked</div>
    <div class="diff-summary">
      <span>${u.diffStats.filesChanged} files</span>
      <span class="diff-added">+${u.diffStats.linesAdded}</span>
      <span class="diff-removed">-${u.diffStats.linesRemoved}</span>
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
