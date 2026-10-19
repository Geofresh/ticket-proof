import fs from "node:fs";
import path from "node:path";
import { previewOf, type Decision, type AnyProject } from "./project.js";
import type { RawAnswers } from "./questions.js";
import type { Scored, Summary } from "./run.js";

export type PracticeRow = {
  id: string;
  preview: string;
  /** The customer's full words (the project's first free-text field), for the HTML report. */
  text?: string;
  severity: number;
  errors: string[];
  expected: Decision;
  actual: Decision;
  /** The model's answers, rounded: choice, score, or yes probability. */
  answers: Record<string, string | number>;
};

export type PracticeReport = {
  label: string;
  at: string;
  project: string;
  variant: string | null;
  datasets: string[];
  provider: string;
  calls: number;
  cacheHits: number;
  spentUsd: number;
  failures: { id: string; error: string }[];
  summary: Summary;
  /** The project's severity weight for every error code. */
  severityWeights?: Record<string, number>;
  rows: PracticeRow[];
};

export function compactAnswers(answers: RawAnswers): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type === "choice") out[name] = answer.choice;
    else if (answer.type === "score") out[name] = Number(answer.score.toFixed(2));
    else out[name] = Number(answer.yes.toFixed(3));
  }
  return out;
}

function fullTextOf(project: AnyProject, input: Record<string, unknown>): string | undefined {
  const field = project.leakage?.freeText?.[0];
  return field && typeof input[field] === "string" ? (input[field] as string) : undefined;
}

export function toRow(project: AnyProject, scored: Scored): PracticeRow {
  return {
    id: scored.ticket.id,
    preview: previewOf(project, scored.ticket.input as Record<string, unknown>),
    text: fullTextOf(project, scored.ticket.input as Record<string, unknown>),
    severity: scored.severity,
    errors: scored.errors,
    expected: scored.expected,
    actual: scored.actual,
    answers: compactAnswers(scored.answers),
  };
}

export const pct = (value: number | null | undefined) => (value == null ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function formatSummary(summary: Summary): string[] {
  const lines: string[] = [];
  lines.push(`fields   ${Object.entries(summary.fieldAccuracy).map(([field, value]) => `${field} ${pct(value)}`).join("  ")}`);
  if (Object.keys(summary.metrics).length) {
    lines.push(
      `metrics  ${Object.entries(summary.metrics)
        .map(([name, value]) => `${name} ${summary.metricKinds[name] === "count" ? String(value) : pct(value)}`)
        .join("  ")}`,
    );
  }
  lines.push(`severity ${Object.entries(summary.bySeverity).map(([level, count]) => `${level}:${count}`).join(" ")}`);
  const codes = Object.entries(summary.errorCodes).slice(0, 8);
  if (codes.length) lines.push(`errors   ${codes.map(([code, count]) => `${code} ${count}`).join("  ")}`);
  return lines;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
