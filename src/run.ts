import { assertNoLeakage } from "./leakage.js";
import { defaultErrors, expectedFor, fieldsOf, type Decision, type PolicyFn, type AnyProject, type Ticket } from "./project.js";
import { Answers, type RawAnswers } from "./questions.js";
import type { Provider } from "./providers/types.js";

export type Scored = {
  ticket: Ticket;
  expected: Decision;
  actual: Decision;
  errors: string[];
  severity: number;
  answers: RawAnswers;
  servedModel: string;
  costUsd: number;
  cached: boolean;
};

export function scoreDecision(project: AnyProject, fields: string[], expected: Decision, actual: Decision): { errors: string[]; severity: number } {
  const errors = (project.errors ?? defaultErrors(fields))(expected, actual);
  let severity = 0;
  for (const code of errors) {
    const weight = project.severity[code];
    if (weight === undefined) throw new Error(`error code ${code} has no severity weight in the project`);
    severity = Math.max(severity, weight);
  }
  return { errors, severity };
}

export function pickPolicy(project: AnyProject, variant: string | null): PolicyFn<Record<string, unknown>, Decision> {
  if (!variant) return project.policy;
  const policy = project.variants?.[variant];
  if (!policy) throw new Error(`no variant ${variant}; the project has: ${Object.keys(project.variants ?? {}).join(", ") || "none"}`);
  return policy;
}

export async function evaluateTicket(project: AnyProject, ticket: Ticket, provider: Provider, policy = project.policy): Promise<Scored> {
  const expected = expectedFor(project, ticket);
  const fields = fieldsOf(project, expected);
  assertNoLeakage(project, ticket.input, [...new Set([...fields, ...Object.keys(expected)])]);
  const result = await provider.ask(ticket.input, project.questions);
  const actual = policy(new Answers(result.answers, project.questions), ticket.input);
  const { errors, severity } = scoreDecision(project, fields, expected, actual);
  return {
    ticket,
    expected,
    actual,
    errors,
    severity,
    answers: result.answers,
    servedModel: result.servedModel,
    costUsd: result.costUsd,
    cached: result.cached,
  };
}

/** Run every ticket with a few workers. Results keep dataset order; failures are returned, not thrown. */
export async function runTickets(
  tickets: Ticket[],
  run: (ticket: Ticket) => Promise<Scored>,
  concurrency = 4,
  stop: (error: unknown) => boolean = () => false,
): Promise<{ scored: Scored[]; failures: { ticket: Ticket; error: unknown }[] }> {
  const results: (Scored | null)[] = new Array(tickets.length).fill(null);
  const failures: { ticket: Ticket; error: unknown }[] = [];
  let next = 0;
  let halted = false;
  const worker = async () => {
    while (!halted) {
      const index = next++;
      if (index >= tickets.length) return;
      const ticket = tickets[index]!;
      try {
        results[index] = await run(ticket);
      } catch (error) {
        failures.push({ ticket, error });
        if (stop(error)) halted = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { scored: results.filter((result): result is Scored => result !== null), failures };
}

export type Summary = {
  cases: number;
  /** Exact-match rate per decision field. */
  fieldAccuracy: Record<string, number | null>;
  metrics: Record<string, number | null>;
  /** Whether each metric is a rate or a count. */
  metricKinds: Record<string, "rate" | "count">;
  /** Which way each metric is good, when the project says. */
  metricBetter: Record<string, "higher" | "lower" | null>;
  /** Tickets per severity (a ticket's worst error). */
  bySeverity: Record<string, number>;
  /** How often each error code fired. */
  errorCodes: Record<string, number>;
  costUsd: number;
};

export function summarize(project: AnyProject, scored: Scored[]): Summary {
  const rate = (hits: number, total: number) => (total === 0 ? null : hits / total);
  const fields = scored.length ? fieldsOf(project, scored[0]!.expected) : ((project.fields as string[] | undefined) ?? []);
  const fieldAccuracy: Record<string, number | null> = {};
  for (const field of fields) {
    fieldAccuracy[field] = rate(scored.filter((row) => JSON.stringify(row.expected[field]) === JSON.stringify(row.actual[field])).length, scored.length);
  }
  const metrics: Record<string, number | null> = {};
  const metricKinds: Record<string, "rate" | "count"> = {};
  const metricBetter: Record<string, "higher" | "lower" | null> = {};
  for (const [name, metric] of Object.entries(project.metrics ?? {})) {
    const pool = scored.filter((row) => (metric.where ? metric.where(row.expected, row.actual) : true));
    const hits = pool.filter((row) => metric.hit(row.expected, row.actual)).length;
    metrics[name] = metric.count ? hits : rate(hits, pool.length);
    metricKinds[name] = metric.count ? "count" : "rate";
    metricBetter[name] = metric.better ?? null;
  }
  const levels = [...new Set([0, ...Object.values(project.severity)])].sort((a, b) => a - b);
  const bySeverity: Record<string, number> = {};
  for (const level of levels) bySeverity[String(level)] = scored.filter((row) => row.severity === level).length;
  const errorCodes: Record<string, number> = {};
  for (const row of scored) for (const code of row.errors) errorCodes[code] = (errorCodes[code] ?? 0) + 1;
  return {
    cases: scored.length,
    fieldAccuracy,
    metrics,
    metricKinds,
    metricBetter,
    bySeverity,
    errorCodes: Object.fromEntries(Object.entries(errorCodes).sort((a, b) => b[1] - a[1])),
    costUsd: Number(scored.reduce((sum, row) => sum + row.costUsd, 0).toFixed(6)),
  };
}
