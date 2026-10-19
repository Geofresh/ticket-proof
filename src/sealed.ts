import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.js";
import type { AnyProject } from "./project.js";
import { summarize, type Scored, type Summary } from "./run.js";

/**
 * Sealed holdouts. `seal` hashes a dataset nobody has practiced on and writes the hash to a
 * `SHA256` file next to it. `grade` checks that hash and returns totals only: no ticket ids,
 * messages, decisions or reasons. `practice`, which prints every ticket, refuses any sealed file.
 */

export class SealedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedError";
  }
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function registryFor(file: string): string {
  return path.join(path.dirname(file), "SHA256");
}

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback;
}

/** Every hash in any `SHA256` file under `root`, skipping dependencies and run output. */
export function sealedHashes(root: string): Set<string> {
  const hashes = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "runs") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SHA256") for (const match of fs.readFileSync(full, "utf8").matchAll(/\b[a-f0-9]{64}\b/g)) hashes.add(match[0]);
    }
  };
  walk(root);
  return hashes;
}

/** Practice prints every ticket, so it must never read a holdout. */
export function assertPracticeFile(file: string, root = ROOT): void {
  // Judge a symlink by where it points.
  const resolved = fs.realpathSync(path.resolve(file));
  const hash = sha256File(resolved);
  const nextTo = registryFor(resolved);
  if (sealedHashes(root).has(hash) || (fs.existsSync(nextTo) && fs.readFileSync(nextTo, "utf8").includes(hash))) {
    throw new SealedError("That file is a sealed holdout. Grade it with `grade`, which returns totals only.");
  }
  // Folder names inside the checkout, or just the parent folder for a file elsewhere.
  const rel = path.relative(root, resolved);
  const parts = rel.startsWith("..") || path.isAbsolute(rel) ? [path.basename(path.dirname(resolved))] : rel.split(path.sep);
  if (parts.some((part) => /^sealed/i.test(part)) || /holdout/i.test(path.basename(resolved))) {
    throw new SealedError(`${path.basename(resolved)} looks like a holdout (a sealed* folder or a holdout* file). Grade it with \`grade\`.`);
  }
}

export function recordPractice(file: string, runsDir: string): void {
  const log = path.join(runsDir, "practiced.json");
  const seen = readJson<Record<string, { file: string; at: string }>>(log, {});
  seen[sha256File(file)] = { file: path.relative(ROOT, path.resolve(file)), at: new Date().toISOString() };
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(log, JSON.stringify(seen, null, 2));
}

/** Register a holdout. Refuses a file you already practiced on and a file sealed under another hash. */
export function sealFile(file: string, runsDir: string): string {
  if (!fs.existsSync(file)) throw new SealedError(`${file} does not exist`);
  const hash = sha256File(file);
  const practiced = readJson<Record<string, unknown>>(path.join(runsDir, "practiced.json"), {});
  if (practiced[hash]) throw new SealedError("You already ran practice on this file, so it is not blind. Write a new holdout.");
  const registry = registryFor(file);
  if (fs.existsSync(registry)) {
    const existing = fs.readFileSync(registry, "utf8");
    if (existing.includes(hash)) return hash;
    throw new SealedError(`${registry} already holds a different hash. The holdout changed after sealing; write a new folder instead.`);
  }
  fs.writeFileSync(registry, `${hash}  ${path.basename(file)}\n`);
  fs.chmodSync(file, 0o444);
  return hash;
}

/** Check a holdout against its registry before anything reads it. */
export function assertSealedHash(file: string, registry = registryFor(file)): string {
  if (!fs.existsSync(file) || !fs.existsSync(registry)) throw new SealedError("No sealed holdout here. Run `seal` on it first, before anyone reads it.");
  const expected = fs.readFileSync(registry, "utf8").trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new SealedError("The SHA256 registry does not hold a sha256.");
  const actual = sha256File(file);
  if (actual !== expected) throw new SealedError("The holdout's hash does not match its registry. It will not be graded or opened to see why.");
  return actual;
}

/** Count grades per holdout. Every grade you act on makes the holdout a little less blind. */
export function recordGrade(hash: string, runsDir: string): number {
  const log = path.join(runsDir, "grades.json");
  const grades = readJson<Record<string, string[]>>(log, {});
  const previous = grades[hash]?.length ?? 0;
  grades[hash] = [...(grades[hash] ?? []), new Date().toISOString()];
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(log, JSON.stringify(grades, null, 2));
  return previous;
}

/** A fixed-vocabulary label for a failed ticket. It names a kind, field or status, never a value. */
export function errorKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "SpendCapError") return "spend_cap";
  if (name === "LeakageError") return "leakage";
  if (name === "CacheMissError") return "cache_miss";
  if (name === "PaidParseError") return "unreadable_reply";
  if (name === "ProviderHttpError") return `provider_http_${(error as { status: number }).status}`;
  const answer = /^(missing|invalid) answer: ([a-z][a-z0-9_]*)$/.exec(message);
  if (answer) return `answer:${answer[2]}`;
  if (/has no severity weight/.test(message)) return "unweighted_error_code";
  if (name === "AbortError" || /abort/i.test(message)) return "timeout";
  return "other";
}

export type SealedTotals = {
  cases: number;
  errors: number;
  errorKinds: Record<string, number>;
  fieldAccuracy: Summary["fieldAccuracy"];
  metrics: Summary["metrics"];
  metricKinds: Summary["metricKinds"];
  bySeverity: Summary["bySeverity"];
  errorCodes: Summary["errorCodes"];
  costUsd: number;
};

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]*(:[a-z][a-z0-9_]*)?$/;

/** Aggregates only. Keys that are not plain identifiers are dropped, so no ticket text can ride along. */
export function toSealedTotals(project: AnyProject, scored: Scored[], failures: unknown[]): SealedTotals {
  const summary = summarize(project, scored);
  const kinds: Record<string, number> = {};
  for (const error of failures) {
    const kind = errorKind(error);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const clean = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => SAFE_NAME.test(key) || /^\d+$/.test(key)));
  return {
    cases: summary.cases,
    errors: failures.length,
    errorKinds: clean(kinds),
    fieldAccuracy: clean(summary.fieldAccuracy),
    metrics: clean(summary.metrics),
    metricKinds: clean(summary.metricKinds),
    bySeverity: clean(summary.bySeverity),
    errorCodes: clean(summary.errorCodes),
    costUsd: summary.costUsd,
  };
}
