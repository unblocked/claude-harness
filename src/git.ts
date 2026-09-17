import { execFileSync } from "node:child_process";
import { log } from "./util.ts";

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

// Run git without a shell. Arguments are passed verbatim, so branch names,
// paths and ref formats need no quoting. Throws on non-zero exit.
// core.quotePath=false: paths with non-ASCII characters come out as UTF-8
// instead of C-quoted octal, so diffs and file lists read correctly.
export function git(cwd: string, args: string[], maxBuffer = DEFAULT_MAX_BUFFER): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, stdio: "pipe", maxBuffer }).toString();
}

// Same, but a failure is logged and reported as null instead of thrown. For
// per-run steps that should degrade rather than abort (CLAUDE.md: log + continue).
export function tryGit(cwd: string, args: string[], what: string): string | null {
  try {
    return git(cwd, args);
  } catch (err) {
    log(`git ${args[0]} failed while ${what}: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false; // exit 1 = not an ancestor; any other failure is treated the same, conservatively
  }
}

// ref name -> sha for every ref in the repo (heads, remotes, tags). Taken once
// before any worktree is created; used to tell the agent's commits apart from
// history that already existed, and to find branches the agent created.
export function snapshotRefs(repoPath: string): Map<string, string> | null {
  const out = tryGit(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)"], "snapshotting refs");
  if (out === null) return null;
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) refs.set(line.slice(sp + 1), line.slice(0, sp));
  }
  return refs;
}

// Names of refs that contain `sha`, with their current tips.
export function refsContaining(cwd: string, sha: string): Map<string, string> {
  const refs = new Map<string, string>();
  const out = tryGit(cwd, ["for-each-ref", "--contains", sha, "--format=%(objectname) %(refname)"], `listing refs containing ${sha.slice(0, 7)}`);
  for (const line of (out ?? "").split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) refs.set(line.slice(sp + 1), line.slice(0, sp));
  }
  return refs;
}

export function commitsBetween(cwd: string, from: string, to: string): number {
  const out = tryGit(cwd, ["rev-list", "--count", `${from}..${to}`], `counting commits ${from.slice(0, 7)}..${to.slice(0, 7)}`);
  return out === null ? 0 : parseInt(out.trim(), 10) || 0;
}
