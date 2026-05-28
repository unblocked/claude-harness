# claude-harness

A/B comparison harness for Claude Code: runs the same coding task twice — once without [Unblocked](https://getunblocked.com) context (baseline) and once with — then produces structured comparison reports.

## How it works

1. Creates two isolated git worktrees from the same branch
2. Runs Claude Code in parallel on both:
   - **Baseline**: all MCP servers and tools available *except* Unblocked (blocked via `--disallowed-tools`)
   - **Unblocked**: all MCP servers and tools available, with a nudge to call `context_research` first and throughout
3. Captures diffs, token usage, cost, tool calls, and timing from both runs
4. Generates console, JSON, and HTML comparison reports

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) installed and authenticated
- [Unblocked MCP server](https://getunblocked.com) configured in Claude Code (or Unblocked CLI for `--cli` mode)

## Usage

```bash
bun start -- --repo /path/to/repo --task "implement feature X"
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--repo <path>` | Path to target git repository | *required* |
| `--task <string>` | Task description for the agent | *required* |
| `--model <model>` | Model for Claude to use | `sonnet` |
| `--timeout <seconds>` | Max seconds per arm | `3600` |
| `--branch <name>` | Branch to base worktrees on | current HEAD |
| `--keep-worktrees` | Don't clean up worktrees after run | `false` |
| `--cli` | Use Unblocked CLI via Bash instead of MCP | `false` |

### Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_BINARY` | Override Claude CLI binary name (default: `claude`) |

### Example

```bash
bun start -- \
  --repo ~/code/my-project \
  --task 'Add rate limiting to the /api/users endpoint following existing patterns' \
  --model claude-opus-4-7 \
  --branch main \
  --keep-worktrees
```

## Output

Results are written to `results/run-<timestamp>/`:

```
results/run-2026-05-27T22-30-49-924Z/
├── baseline/
│   └── baseline.jsonl       # Raw Claude stream-json output
├── unblocked/
│   └── unblocked.jsonl      # Raw Claude stream-json output
├── result.json              # Structured comparison data
└── report.html              # Visual comparison report
```

The HTML report opens automatically and includes:
- Head-to-head bar charts (duration, tokens, cost)
- Per-arm detail cards with token breakdowns
- Tool usage breakdown table
- Unblocked context queries used
- Full diffs from both arms

## Architecture

```
src/
├── index.ts      CLI entry point (commander)
├── runner.ts     Orchestration: parallel arm execution, diff capture, nudge prompts
├── claude.ts     Spawn Claude Code CLI, parse stream-json, worktree management
├── report.ts     Console + HTML + JSON report generation
├── util.ts       Token pricing, formatting helpers
└── types.ts      Shared type definitions
```

### Contamination guards

- **Baseline arm**: Unblocked MCP tools and CLI blocked via `--disallowed-tools`. If the baseline somehow calls Unblocked, the run is killed immediately.
- **Unblocked arm**: If Unblocked isn't called within 120 seconds, the run is killed (ensures the nudge prompt worked).

### How blocking works

The baseline arm passes separate `--disallowed-tools` flags for each Unblocked MCP tool and the Unblocked CLI pattern. The prompt is piped via stdin (not as a positional arg) to avoid the variadic `--disallowed-tools` flag consuming it.

## Tips for good comparison tasks

Tasks where Unblocked adds the most value involve **institutional knowledge** — information that lives outside the code:

- Features requiring understanding of team conventions not documented in code
- Bug fixes where root cause context is in PR discussions or issue trackers
- Implementations where prior attempts were rejected (Unblocked surfaces the why)
- Work touching systems with recent incidents or operational concerns

Tasks where Unblocked adds less value:
- Mechanical pattern-copying (e.g., "add a new model to this list")
- Pure algorithmic work with no team context needed
- Tasks where the code tells the complete story
