import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { formatCompare } from "./compare.js";
import { renderReport } from "./html.js";
import { ROOT } from "./env.js";
import { loadProject, loadTickets, type AnyProject, type Ticket } from "./project.js";
import { buildProvider, SpendCapError } from "./providers/index.js";
import { formatSummary, toRow, writeJson, type PracticeReport } from "./report.js";
import { evaluateTicket, pickPolicy, runTickets, summarize } from "./run.js";
import { assertPracticeFile, assertSealedHash, recordGrade, recordPractice, SealedError, sealFile, toSealedTotals } from "./sealed.js";

const RUNS = path.join(ROOT, "runs");
const USAGE = `usage:
  practice <project> <dataset.json...> [--label name] [--variant name] [--offline] [--concurrency n]
  compare <before label|file> <after label|file>
  report <label|file> [--vs <baseline label|file>] [--out page.html]
  seal <holdout.json>
  grade <project> <holdout.json> [--out totals.json]
  demo`;

type Flags = { positional: string[]; flags: Map<string, string | true> };

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "offline") flags.set(name, true);
    else flags.set(name, argv[++index] ?? "");
  }
  return { positional, flags };
}

/** pnpm runs scripts from the package folder; resolve paths against where the command was typed. */
function fromCwd(file: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
}

function cacheDirFor(project: AnyProject, dir: string): string {
  return project.cacheDir ? path.resolve(dir, project.cacheDir) : path.join(RUNS, "cache", project.name);
}

export async function practice(args: Flags): Promise<PracticeReport> {
  const [projectSpec, ...datasets] = args.positional;
  if (!projectSpec || datasets.length === 0) throw new Error(USAGE);
  const { project, dir } = await loadProject(fromCwd(projectSpec));
  const variant = (args.flags.get("variant") as string | undefined) ?? null;
  const label = (args.flags.get("label") as string | undefined) ?? (variant ? `${project.name}-${variant}` : project.name);
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("label may use letters, digits, dot, dash and underscore only");
  const policy = pickPolicy(project, variant);
  const files = datasets.map(fromCwd);
  for (const file of files) assertPracticeFile(file);
  const tickets: Ticket[] = files.flatMap((file) => loadTickets(file));
  for (const file of files) recordPractice(file, RUNS);

  const built = buildProvider({ cacheDir: cacheDirFor(project, dir), offline: args.flags.has("offline"), defaults: project.defaults });
  const before = built.ledger?.total() ?? 0;
  const { scored, failures } = await runTickets(
    tickets,
    (ticket) => evaluateTicket(project, ticket, built.provider, policy),
    Number(args.flags.get("concurrency") ?? 4),
    (error) => error instanceof SpendCapError,
  );
  const rows = scored.map((row) => toRow(project, row));
  const report: PracticeReport = {
    label,
    at: new Date().toISOString(),
    project: project.name,
    variant,
    datasets: files.map((file) => path.relative(ROOT, file)),
    provider: built.describe,
    calls: built.paid?.calls ?? 0,
    cacheHits: built.cache?.hits ?? 0,
    spentUsd: Number(((built.ledger?.total() ?? 0) - before).toFixed(6)),
    failures: failures.map(({ ticket, error }) => ({ id: ticket.id, error: error instanceof Error ? error.message.slice(0, 300) : String(error) })),
    summary: summarize(project, scored),
    severityWeights: project.severity,
    rows,
  };
  const out = path.join(RUNS, "practice", `${label}.json`);
  writeJson(out, report);
  console.log(
    [
      `${label}: ${rows.length} scored, ${failures.length} failed, ${report.calls} calls, ${report.cacheHits} cached, $${report.spentUsd.toFixed(4)} spent (${built.describe})`,
      ...formatSummary(report.summary),
      `report   ${path.relative(process.env.INIT_CWD ?? process.cwd(), out)}`,
    ].join("\n"),
  );
  for (const failure of report.failures.slice(0, 5)) console.log(`failed   ${failure.id}: ${failure.error}`);
  if (failures.length) process.exitCode = 1;
  return report;
}

function loadReport(spec: string): PracticeReport {
  const asFile = fromCwd(spec);
  const file = fs.existsSync(asFile) ? asFile : path.join(RUNS, "practice", `${spec.replace(/\.json$/, "")}.json`);
  if (!fs.existsSync(file)) throw new Error(`no practice report ${spec} (looked in runs/practice/)`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as PracticeReport;
}

function compare(args: Flags): void {
  const [before, after] = args.positional;
  if (!before || !after) throw new Error(USAGE);
  console.log(formatCompare(loadReport(before), loadReport(after)).join("\n"));
}

function writeHtml(after: PracticeReport, before: PracticeReport | null, out: string | null, note?: string): string {
  const name = before ? `${before.label}-vs-${after.label}` : after.label;
  const target = out ?? path.join(RUNS, "report", `${name}.html`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderReport(after, before, { note }));
  return target;
}

function report(args: Flags): void {
  const [spec] = args.positional;
  if (!spec) throw new Error(USAGE);
  const vs = args.flags.get("vs");
  const out = args.flags.get("out");
  const target = writeHtml(loadReport(spec), typeof vs === "string" && vs ? loadReport(vs) : null, typeof out === "string" && out ? fromCwd(out) : null);
  console.log(`report   ${path.relative(process.env.INIT_CWD ?? process.cwd(), target)}`);
}

function seal(args: Flags): void {
  const [file] = args.positional;
  if (!file) throw new Error(USAGE);
  const hash = sealFile(fromCwd(file), RUNS);
  console.log(`sealed ${hash}\nThe file is now read-only. Commit SHA256 with it, do not open it, and grade it with \`grade\`.`);
}

async function grade(args: Flags): Promise<void> {
  const [projectSpec, file] = args.positional;
  if (!projectSpec || !file) throw new Error(USAGE);
  const holdout = fromCwd(file);
  const hash = assertSealedHash(holdout);
  const { project } = await loadProject(fromCwd(projectSpec));
  // No response cache: a sealed grade is a fresh call, and rescoring it for free invites tuning to it.
  const built = buildProvider({ cacheDir: null, offline: false, defaults: project.defaults });
  let tickets: Ticket[];
  try {
    tickets = loadTickets(holdout);
  } catch {
    // The loader's message can name a ticket. Say only that it failed.
    throw new SealedError("The holdout does not load as a dataset. Rewrite and reseal it rather than opening it.");
  }
  const previous = recordGrade(hash, RUNS);
  if (previous > 0) console.error(`note: this holdout was graded ${previous} time(s) before. Every grade you act on makes it less blind.`);
  const { scored, failures } = await runTickets(
    tickets,
    (ticket) => evaluateTicket(project, ticket, built.provider),
    Number(args.flags.get("concurrency") ?? 4),
    (error) => error instanceof SpendCapError,
  );
  const totals = toSealedTotals(project, scored, failures.map((failure) => failure.error));
  const out = args.flags.get("out");
  const target = typeof out === "string" && out ? fromCwd(out) : path.join(RUNS, "grades", `${hash.slice(0, 12)}-${Date.now()}.json`);
  writeJson(target, { hash, project: project.name, provider: built.describe, totals });
  console.log(JSON.stringify(totals, null, 2));
}

async function demo(): Promise<void> {
  const example = path.join(ROOT, "examples", "acmecloud");
  const tickets = path.join(example, "tickets.json");
  console.log(
    [
      "Demo: the AcmeCloud example, scored from cached model answers. No API key, no calls, no spend.",
      "These tickets were written by an LLM from the same policy that grades them. The numbers show",
      "how the harness works; they say nothing about any model or any real support queue.",
      "",
    ].join("\n"),
  );
  console.log("== the model's answers alone, with fixed thresholds ==");
  const modelOnly = await practice({ positional: [example, tickets], flags: new Map<string, string | true>([["offline", true], ["variant", "model-only"], ["label", "demo-model-only"]]) });
  console.log("\n== the same answers through the example policy ==");
  const withPolicy = await practice({ positional: [example, tickets], flags: new Map<string, string | true>([["offline", true], ["label", "demo-policy"]]) });
  console.log("\n== compare demo-model-only -> demo-policy ==");
  console.log(formatCompare(modelOnly, withPolicy).join("\n"));
  const page = writeHtml(
    withPolicy,
    modelOnly,
    path.join(RUNS, "report", "demo.html"),
    "Demo data: an LLM wrote these tickets from the same policy that grades them, so the numbers only show how the tool works.",
  );
  console.log(`\nhtml report: ${path.relative(process.env.INIT_CWD ?? process.cwd(), page)} (open it in a browser)`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "practice") await practice(args);
  else if (command === "compare") compare(args);
  else if (command === "report") report(args);
  else if (command === "seal") seal(args);
  else if (command === "grade") await grade(args);
  else if (command === "demo") await demo();
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof SealedError ? 3 : 1;
  });
}
