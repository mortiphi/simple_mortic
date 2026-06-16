import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

import type { CanonicalItem } from "../../shared/types.js";

export type CodeCommitEvidence = {
  hash: string;
  subject: string;
  committedAt: string;
};

export type CommitItemMatch = {
  item: CanonicalItem;
  commit: CodeCommitEvidence;
  score: number;
};

// Generic verbs and connective words that overlap across unrelated commits and
// items; conventional-commit type keywords are dropped here too so a leftover
// "fix"/"feat" token never counts as evidence.
const reconcileStopwords = new Set([
  "mortic",
  "should",
  "would",
  "with",
  "from",
  "that",
  "this",
  "into",
  "using",
  "fix",
  "feat",
  "chore",
  "refactor",
  "update",
  "updates",
  "implement",
  "implementation",
  "remove",
  "removes",
  "removed",
  "tests",
  "test",
  "docs",
  "doc",
  "perf",
  "improve",
  "improves",
  "improved",
  "support",
  "change",
  "changes"
]);

function reconcileTokens(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !reconcileStopwords.has(token));
  return new Set(tokens);
}

function stripConventionalPrefix(subject: string): string {
  return subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "");
}

// Pure, deterministic title/subject token matching: at most one (best-scoring)
// commit per item, and only when the commit covers most of the item title's
// tokens — the denominator is the item title token count so a short commit
// subject cannot inflate the score.
export function matchCommitsToItems(items: CanonicalItem[], commits: CodeCommitEvidence[]): CommitItemMatch[] {
  const matches: CommitItemMatch[] = [];
  for (const item of items) {
    const itemTokens = reconcileTokens(item.title);
    if (itemTokens.size === 0) continue;
    let best: CommitItemMatch | undefined;
    for (const commit of commits) {
      const commitTokens = reconcileTokens(stripConventionalPrefix(commit.subject));
      if (commitTokens.size === 0) continue;
      const intersection = [...itemTokens].filter((token) => commitTokens.has(token));
      if (intersection.length < 2) continue;
      const score = intersection.length / itemTokens.size;
      if (score < 0.6) continue;
      if (!best || score > best.score) best = { item, commit, score };
    }
    if (best) matches.push(best);
  }
  return matches;
}

const gitCommandTimeoutMs = 4000;

// Spawn git with a hard timeout: a hung child is SIGTERM-killed and the call
// resolves as a failure (undefined) instead of stalling the compile flow.
function runGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(undefined);
    }, gitCommandTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => settle(undefined));
    child.on("close", (code) => settle(code === 0 ? output : undefined));
  });
}

// The workspace itself must be the repository toplevel: a non-repo workspace
// nested inside an unrelated outer repository must not match foreign commits.
async function workspaceIsRepositoryRoot(cwd: string): Promise<boolean> {
  const toplevel = (await runGit(["rev-parse", "--show-toplevel"], cwd))?.trim();
  if (!toplevel) return false;
  try {
    const [realToplevel, realWorkspace] = await Promise.all([realpath(toplevel), realpath(cwd)]);
    return realToplevel === realWorkspace;
  } catch {
    return false;
  }
}

// Read-only look at the workspace git history. Any failure (no git binary,
// not a repository, empty history, timeout) degrades to "no evidence" instead
// of surfacing an error into the compile flow.
export async function readRecentCommits(cwd: string, sinceIso?: string, limit = 50): Promise<CodeCommitEvidence[]> {
  if (!(await workspaceIsRepositoryRoot(cwd))) return [];
  const args = ["log", "--no-merges", "--pretty=format:%H%x09%cI%x09%s", "-n", String(limit)];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  const stdout = await runGit(args, cwd);
  if (stdout === undefined) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, committedAt, ...subjectParts] = line.split("\t");
      return {
        hash: hash ?? "",
        committedAt: committedAt ?? "",
        subject: subjectParts.join("\t").trim().slice(0, 200)
      };
    })
    .filter((commit) => commit.hash && commit.subject);
}
