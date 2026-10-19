import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Answers, Questions } from "./questions.js";

/** A decision is a flat record your policy returns and your dataset expects. */
export type DecisionValue = string | number | boolean | null;
export type Decision = Record<string, DecisionValue>;

/**
 * One dataset row. `input` is exactly what the model sees. `facts` is your ground truth about the
 * ticket and is never sent. `expected` may be written out, or derived from facts by `project.expected`.
 */
export type Ticket<Input = Record<string, unknown>, Facts = Record<string, unknown>, D extends Decision = Decision> = {
  id: string;
  input: Input;
  facts?: Facts;
  expected?: D;
  note?: string;
};

/**
 * Policy code sees the model's answers and the same input the model saw. It never sees the ticket
 * id, facts or expected decision, so it cannot special-case a test ticket.
 */
export type PolicyFn<Input, D extends Decision> = (answers: Answers, input: Input) => D;

/** A metric over scored tickets. `where` picks the denominator; `hit` the numerator. */
export type Metric<D extends Decision> = {
  where?: (expected: D, actual: D) => boolean;
  hit: (expected: D, actual: D) => boolean;
  /** Report the number of hits instead of a rate. */
  count?: boolean;
  /** Which way is good, for coloring changes in the HTML report. Omit to leave changes uncolored. */
  better?: "higher" | "lower";
};

export type ProviderDefaults = {
  provider?: "openrouter-decisions" | "openai-compatible";
  model?: string;
  baseUrl?: string;
};

export type Project<Input = Record<string, unknown>, Facts = Record<string, unknown>, D extends Decision = Decision> = {
  name: string;
  questions: Questions;
  /** Your policy: model answers in, decision out. Thresholds and overrides live here, in code. */
  policy: PolicyFn<Input, D>;
  /** Other policies to compare against, such as "the model alone". Run with `--variant <name>`. */
  variants?: Record<string, PolicyFn<Input, D>>;
  /** Facts-to-expected hook. Used when a ticket has facts and no written `expected`. */
  expected?: (facts: Facts, ticket: Ticket<Input, Facts, D>) => D;
  /** Error codes for one ticket. Default: `<field>_mismatch` for every field that differs. */
  errors?: (expected: D, actual: D) => string[];
  /** Severity weight of every error code (0 = cosmetic). A ticket's severity is its worst error. */
  severity: Record<string, number>;
  /** Decision fields to score and show. Default: every field of the expected decision. */
  fields?: (keyof D & string)[];
  metrics?: Record<string, Metric<D>>;
  leakage?: {
    /** Keys that must never appear anywhere in the input. Decision fields and fact names are added. */
    forbiddenKeys?: string[];
    /** Strings that must not appear in the input outside `freeText` fields (such as workflow names). */
    forbiddenTokens?: string[];
    /** Top-level input fields that hold the customer's own words; they are not token-scanned. */
    freeText?: string[];
  };
  /** One line shown for a ticket in reports. Default: the first free-text field. */
  preview?: (input: Input) => string;
  defaults?: ProviderDefaults;
  /** Response cache folder, relative to the project file. Default: runs/cache/<name> (git-ignored). */
  cacheDir?: string;
};

/** Any project, for harness code that does not care about its types. */
export type AnyProject = Project<any, any, any>;

export function defineProject<Input, Facts, D extends Decision>(project: Project<Input, Facts, D>): Project<Input, Facts, D> {
  return project;
}

export async function loadProject(spec: string): Promise<{ project: AnyProject; dir: string }> {
  let file = path.resolve(spec);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "project.ts");
  if (!fs.existsSync(file)) throw new Error(`no project at ${spec} (expected a project.ts file or a folder holding one)`);
  const mod = (await import(pathToFileURL(file).href)) as { default?: AnyProject };
  if (!mod.default?.policy || !mod.default.questions) throw new Error(`${spec} must default-export defineProject({...})`);
  return { project: mod.default, dir: path.dirname(file) };
}

export function loadTickets(file: string): Ticket[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : (parsed as { tickets?: unknown })?.tickets;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${path.basename(file)} has no tickets`);
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const ticket = row as Ticket;
    if (!ticket || typeof ticket.id !== "string" || !ticket.id) throw new Error(`ticket ${index} has no id`);
    if (seen.has(ticket.id)) throw new Error(`duplicate ticket id ${ticket.id}`);
    seen.add(ticket.id);
    if (!ticket.input || typeof ticket.input !== "object") throw new Error(`ticket ${ticket.id} has no input`);
    if (!ticket.expected && !ticket.facts) throw new Error(`ticket ${ticket.id} has neither facts nor expected`);
    return ticket;
  });
}

export function expectedFor(project: AnyProject, ticket: Ticket): Decision {
  if (ticket.expected) return ticket.expected;
  if (!project.expected) throw new Error(`ticket ${ticket.id} has facts but the project has no expected() hook`);
  return project.expected(ticket.facts!, ticket);
}

/** Field list for scoring and reports. */
export function fieldsOf(project: AnyProject, expected: Decision): string[] {
  return (project.fields as string[] | undefined) ?? Object.keys(expected);
}

export function defaultErrors(fields: string[]) {
  return (expected: Decision, actual: Decision): string[] =>
    fields.filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(actual[field])).map((field) => `${field}_mismatch`);
}

export function previewOf(project: AnyProject, input: Record<string, unknown>): string {
  if (project.preview) return project.preview(input);
  const field = project.leakage?.freeText?.[0];
  const text = field && typeof input[field] === "string" ? (input[field] as string) : JSON.stringify(input);
  return text.replace(/\s+/g, " ").slice(0, 120);
}
