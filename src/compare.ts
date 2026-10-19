import type { PracticeReport, PracticeRow } from "./report.js";
import { pct } from "./report.js";

export type TicketChange = { id: string; before: PracticeRow; after: PracticeRow; severityDelta: number };

/** Every ticket whose decision or severity changed, worst change first. */
export function changedTickets(before: PracticeRow[], after: PracticeRow[]): TicketChange[] {
  const byId = new Map(before.map((row) => [row.id, row]));
  const changes: TicketChange[] = [];
  for (const row of after) {
    const old = byId.get(row.id);
    if (!old) continue;
    if (JSON.stringify(old.actual) === JSON.stringify(row.actual) && old.severity === row.severity) continue;
    changes.push({ id: row.id, before: old, after: row, severityDelta: row.severity - old.severity });
  }
  return changes.sort((a, b) => b.severityDelta - a.severityDelta || a.id.localeCompare(b.id));
}

function diffFields(before: PracticeRow, after: PracticeRow): string {
  const fields = Object.keys(after.actual).filter((field) => JSON.stringify(before.actual[field]) !== JSON.stringify(after.actual[field]));
  return fields.map((field) => `${field} ${String(before.actual[field])}->${String(after.actual[field])} (expected ${String(after.expected[field])})`).join("  ");
}

export function formatCompare(before: PracticeReport, after: PracticeReport): string[] {
  const lines: string[] = [];
  const unshared = before.rows.length !== after.rows.length || before.rows.some((row, index) => row.id !== after.rows[index]?.id);
  if (unshared) lines.push("note: the two runs did not score the same tickets; totals are not comparable, ticket changes cover shared ids only");
  const line = (name: string, x: string, y: string) => lines.push(`${x === y ? " " : "*"} ${name.padEnd(28)} ${x.padStart(7)} -> ${y}`);
  for (const field of Object.keys(after.summary.fieldAccuracy)) line(field, pct(before.summary.fieldAccuracy[field]), pct(after.summary.fieldAccuracy[field]));
  for (const [name, value] of Object.entries(after.summary.metrics)) {
    const old = before.summary.metrics[name];
    const isCount = after.summary.metricKinds[name] === "count";
    line(name, isCount ? String(old ?? "n/a") : pct(old), isCount ? String(value ?? "n/a") : pct(value));
  }
  for (const level of Object.keys(after.summary.bySeverity)) {
    line(`severity ${level} tickets`, String(before.summary.bySeverity[level] ?? 0), String(after.summary.bySeverity[level] ?? 0));
  }
  const changes = changedTickets(before.rows, after.rows);
  const worse = changes.filter((change) => change.severityDelta > 0).length;
  const better = changes.filter((change) => change.severityDelta < 0).length;
  lines.push("", `${changes.length} tickets changed: ${worse} worse, ${better} better, ${changes.length - worse - better} same severity`);
  for (const { id, before: old, after: now, severityDelta } of changes) {
    const tag = severityDelta > 0 ? "WORSE " : severityDelta < 0 ? "better" : "same  ";
    lines.push(`${tag} ${id}: severity ${old.severity}->${now.severity}  ${diffFields(old, now)}`);
    lines.push(`         | ${now.preview.slice(0, 100)}`);
  }
  return lines;
}
