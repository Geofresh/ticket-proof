import { changedTickets } from "./compare.js";
import type { PracticeReport, PracticeRow } from "./report.js";

/**
 * One self-contained HTML page for a practice run, optionally against a baseline run.
 * No server, no network: styles, script and data are all inline, so the file can be opened from
 * disk, attached to CI, or mailed. Summaries are rendered here; the ticket list is filtered in the
 * browser from the embedded rows.
 */
export type HtmlOptions = { note?: string };

const esc = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

/** JSON that is safe inside a <script> element. */
export const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(LINE_SEPARATOR, "\\u2028").replace(PARAGRAPH_SEPARATOR, "\\u2029");

const pct = (value: number | null | undefined) => (value == null ? "n/a" : `${Math.round(value * 1000) / 10}%`);

const ACRONYMS = new Set(["api", "sso", "id", "ip", "url", "vip", "sla", "saml"]);

/** `criticalHumanRecall` / `missed_human` -> "Critical human recall" / "Missed human". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  return words.map((word, index) => (ACRONYMS.has(word) ? word.toUpperCase() : index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
}

/** Severity levels mapped onto a five-step color scale, lowest = fine, highest = worst. */
export function severityTone(level: number, levels: number[]): number {
  const index = levels.indexOf(level);
  if (levels.length <= 1 || index < 0) return 0;
  return Math.round((index / (levels.length - 1)) * 4);
}

const TONE_NAMES = ["No mistake", "Minor", "Moderate", "Serious", "Critical"];

/** A plain name per severity level, from its tone; repeated names get the level number. */
export function severityNames(levels: number[]): Record<number, string> {
  const names = levels.map((level) => TONE_NAMES[severityTone(level, levels)]!);
  return Object.fromEntries(levels.map((level, index) => [level, names.filter((name) => name === names[index]).length > 1 ? `${names[index]} (${level})` : names[index]!]));
}

type Direction = "higher" | "lower" | null;

function delta(before: number | null | undefined, after: number | null | undefined, kind: "rate" | "count", better: Direction): string {
  if (before == null || after == null) return "";
  const diff = after - before;
  if (Math.abs(diff) < 1e-9) return `<span class="delta flat">same</span>`;
  const text = kind === "rate" ? `${diff > 0 ? "▲" : "▼"} ${Math.abs(Math.round(diff * 1000) / 10)} pts` : `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}`;
  const tone = better === null ? "neutral" : (diff > 0) === (better === "higher") ? "good" : "bad";
  return `<span class="delta ${tone}">${text}</span>`;
}

const countAtLeast = (report: PracticeReport, min: number) =>
  Object.entries(report.summary.bySeverity).reduce((sum, [level, count]) => (Number(level) >= min ? sum + count : sum), 0);

function card(label: string, value: string, sub: string, tip?: string): string {
  return `<div class="card"${tip ? ` title="${esc(tip)}"` : ""}><div class="card-label">${esc(label)}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div></div>`;
}

function summaryCards(after: PracticeReport, before: PracticeReport | null, levels: number[], names: Record<number, string>): string {
  const total = after.summary.cases;
  const clean = levels[0] ?? 0;
  const serious = levels.find((level) => severityTone(level, levels) >= 3) ?? levels[levels.length - 1] ?? 0;
  const cleanNow = after.summary.bySeverity[String(clean)] ?? 0;
  const seriousNow = countAtLeast(after, serious);
  const cards: string[] = [];
  if (before) {
    const changes = changedTickets(before.rows, after.rows);
    const worse = changes.filter((change) => change.severityDelta > 0).length;
    const better = changes.filter((change) => change.severityDelta < 0).length;
    cards.push(
      card(
        "Tickets that changed",
        String(changes.length),
        `<span class="delta good">${better} better</span> <span class="delta bad">${worse} worse</span>`,
        `${changes.length - worse - better} changed their decision without changing severity`,
      ),
    );
  } else {
    cards.push(card("Tickets", String(total), esc(after.project)));
  }
  cards.push(
    card(
      `${names[serious] ?? "Serious"} mistakes`,
      String(seriousNow),
      before ? `${delta(countAtLeast(before, serious), seriousNow, "count", "lower")} <span class="muted">was ${countAtLeast(before, serious)}</span>` : `<span class="muted">severity ${serious} or worse</span>`,
      "Tickets whose worst mistake is at this severity or higher",
    ),
  );
  cards.push(
    card(
      "Handled right",
      `${cleanNow}<span class="of">/${total}</span>`,
      before ? `${delta(before.summary.bySeverity[String(clean)] ?? 0, cleanNow, "count", "higher")} <span class="muted">was ${before.summary.bySeverity[String(clean)] ?? 0}</span>` : `<span class="muted">no mistakes at all</span>`,
    ),
  );
  cards.push(card("Cost", `$${after.spentUsd.toFixed(2)}`, `<span class="muted">${after.calls} calls · ${after.cacheHits} cached</span>`, after.provider));
  return `<div class="cards">${cards.join("")}</div>`;
}

function severityBar(report: PracticeReport, levels: number[], names: Record<number, string>, caption: string | null): string {
  const total = report.summary.cases || 1;
  const segments = levels
    .map((level) => {
      const count = report.summary.bySeverity[String(level)] ?? 0;
      if (!count) return "";
      const share = (count / total) * 100;
      return `<span class="seg tone${severityTone(level, levels)}" style="width:${share.toFixed(3)}%" title="${esc(names[level])}: ${count}">${share >= 6 ? count : ""}</span>`;
    })
    .join("");
  const label = levels.map((level) => `${names[level]}: ${report.summary.bySeverity[String(level)] ?? 0}`).join(", ");
  return `<div class="barrow">${caption === null ? "" : `<div class="barlabel">${esc(caption)}</div>`}<div class="bar" role="img" aria-label="${esc(label)}">${segments}</div></div>`;
}

function severitySection(after: PracticeReport, before: PracticeReport | null, levels: number[], names: Record<number, string>): string {
  const legend = levels
    .map((level) => {
      const now = after.summary.bySeverity[String(level)] ?? 0;
      const old = before ? (before.summary.bySeverity[String(level)] ?? 0) : null;
      return `<li><span class="dot tone${severityTone(level, levels)}"></span>${esc(names[level])} <b>${now}</b>${
        old === null ? "" : ` ${delta(old, now, "count", level === levels[0] ? "higher" : "lower")}`
      }</li>`;
    })
    .join("");
  const bars = before
    ? severityBar(before, levels, names, "Before") + severityBar(after, levels, names, "After")
    : severityBar(after, levels, names, null);
  return `<section aria-labelledby="sev-h"><h2 id="sev-h">How bad were the mistakes?</h2>${bars}<ul class="legend">${legend}</ul></section>`;
}

function fieldsSection(after: PracticeReport, before: PracticeReport | null): string {
  const rows = Object.entries(after.summary.fieldAccuracy)
    .map(([field, value]) => {
      const old = before?.summary.fieldAccuracy[field];
      const width = value == null ? 0 : value * 100;
      return `<tr><th scope="row">${esc(humanize(field))}</th><td class="meter"><span class="track"><span class="fill" style="width:${width.toFixed(2)}%"></span>${
        old == null ? "" : `<span class="was" style="left:${(old * 100).toFixed(2)}%" title="Before: ${pct(old)}"></span>`
      }</span></td><td class="num">${pct(value)}</td>${before ? `<td class="num">${delta(old, value, "rate", "higher")}</td>` : ""}</tr>`;
    })
    .join("");
  return `<section aria-labelledby="fields-h"><h2 id="fields-h">Right answer, by decision</h2>${
    before ? `<p class="hint"><span class="was-key"></span> marks before</p>` : ""
  }<table class="fields"><tbody>${rows}</tbody></table></section>`;
}

function metricsSection(after: PracticeReport, before: PracticeReport | null): string {
  const entries = Object.entries(after.summary.metrics);
  if (!entries.length) return "";
  const tiles = entries
    .map(([name, value]) => {
      const kind = after.summary.metricKinds[name] ?? "rate";
      const shown = kind === "count" ? String(value ?? "n/a") : pct(value);
      const old = before?.summary.metrics[name];
      return `<div class="tile" title="${esc(name)}"><div class="tile-label">${esc(humanize(name))}</div><div class="tile-value">${esc(shown)}</div>${
        before ? `<div>${delta(old, value, kind, after.summary.metricBetter?.[name] ?? null)}</div>` : ""
      }</div>`;
    })
    .join("");
  return `<section aria-labelledby="metrics-h"><h2 id="metrics-h">Key checks</h2><div class="tiles">${tiles}</div></section>`;
}

function errorsSection(after: PracticeReport, before: PracticeReport | null, levels: number[], names: Record<number, string>): string {
  const codes = [...new Set([...Object.keys(after.summary.errorCodes), ...Object.keys(before?.summary.errorCodes ?? {})])];
  if (!codes.length) return `<section aria-labelledby="errors-h"><h2 id="errors-h">Most common mistakes</h2><p class="hint">None.</p></section>`;
  const weights = after.severityWeights ?? {};
  const now = (code: string) => after.summary.errorCodes[code] ?? 0;
  const sorted = codes.sort((a, b) => now(b) - now(a) || (weights[b] ?? -1) - (weights[a] ?? -1) || a.localeCompare(b));
  const max = Math.max(1, ...sorted.map((code) => Math.max(now(code), before?.summary.errorCodes[code] ?? 0)));
  const rows = sorted
    .map((code) => {
      const old = before ? (before.summary.errorCodes[code] ?? 0) : null;
      const weight = weights[code];
      const tone = weight === undefined ? "" : ` tone${severityTone(weight, levels)}`;
      return `<tr class="${now(code) ? "" : "gone"}"><th scope="row" title="${esc(code)}${weight === undefined ? "" : ` · ${esc(names[weight] ?? `severity ${weight}`)}`}"><span class="dot${tone}"></span>${esc(
        humanize(code),
      )}</th><td class="meter"><span class="track"><span class="fill${tone}" style="width:${((now(code) / max) * 100).toFixed(2)}%"></span></span></td><td class="num">${now(code)}</td>${
        old === null ? "" : `<td class="num">${delta(old, now(code), "count", "lower")}</td>`
      }</tr>`;
    })
    .join("");
  return `<section aria-labelledby="errors-h"><h2 id="errors-h">Most common mistakes</h2><table class="errors"><tbody>${rows}</tbody></table></section>`;
}

type ClientRow = Pick<PracticeRow, "id" | "preview" | "text" | "severity" | "errors" | "expected" | "actual" | "answers"> & {
  base?: Pick<PracticeRow, "severity" | "errors" | "actual">;
};

export function renderReport(after: PracticeReport, before: PracticeReport | null = null, options: HtmlOptions = {}): string {
  const levels = Object.keys(after.summary.bySeverity)
    .map(Number)
    .sort((a, b) => a - b);
  const names = severityNames(levels);
  const baseById = new Map((before?.rows ?? []).map((row) => [row.id, row]));
  const rows: ClientRow[] = after.rows.map((row) => {
    const base = baseById.get(row.id);
    return {
      id: row.id,
      preview: row.preview,
      text: row.text,
      severity: row.severity,
      errors: row.errors,
      expected: row.expected,
      actual: row.actual,
      answers: row.answers,
      ...(base ? { base: { severity: base.severity, errors: base.errors, actual: base.actual } } : {}),
    };
  });
  const unshared = before && (before.rows.length !== after.rows.length || before.rows.some((row, index) => row.id !== after.rows[index]?.id));
  const title = before ? `${before.label} → ${after.label}` : after.label;
  const labels: Record<string, string> = {};
  for (const name of [
    ...Object.keys(after.summary.fieldAccuracy),
    ...Object.keys(after.severityWeights ?? {}),
    ...after.rows.flatMap((row) => [...row.errors, ...Object.keys(row.answers), ...Object.keys(row.expected)]),
    ...(before?.rows ?? []).flatMap((row) => row.errors),
  ]) {
    labels[name] ??= humanize(name);
  }
  const data = {
    rows,
    compared: Boolean(before),
    levels,
    names,
    labels,
    weights: after.severityWeights ?? {},
    fields: Object.keys(after.summary.fieldAccuracy),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ticket-proof</title>
<style>${STYLES}</style>
</head>
<body>
<header class="top">
  <div class="eyebrow">ticket-proof</div>
  <h1>${before ? `<span class="muted">${esc(before.label)}</span> <span class="arrow" aria-hidden="true">→</span><span class="sr"> compared with </span> ${esc(after.label)}` : esc(after.label)}</h1>
  <p class="meta" title="${esc(after.provider)}">${esc(after.summary.cases)} tickets · ${esc(new Date(after.at).toISOString().slice(0, 10))}</p>
  ${options.note ? `<p class="note">${esc(options.note)}</p>` : ""}
  ${unshared ? `<p class="note warn">These runs scored different tickets, so totals don't compare. Ticket changes cover shared tickets only.</p>` : ""}
  ${after.failures.length ? `<p class="note warn">${after.failures.length} ticket(s) failed to score and aren't counted.</p>` : ""}
</header>
<main>
${summaryCards(after, before, levels, names)}
${severitySection(after, before, levels, names)}
<div class="cols">
${fieldsSection(after, before)}
<div class="stack">${metricsSection(after, before)}${errorsSection(after, before, levels, names)}</div>
</div>
<section aria-labelledby="tickets-h" class="tickets">
  <div class="tickets-head">
    <h2 id="tickets-h">Tickets</h2>
    <p class="count" id="count" aria-live="polite"></p>
  </div>
  <div class="toolbar">
    <label class="search"><span class="sr">Search tickets</span><input id="q" type="search" placeholder="Search tickets" autocomplete="off"></label>
    <div class="chips" role="group" aria-label="Show" id="views"></div>
  </div>
  <ul class="list" id="rows"></ul>
</section>
</main>
<script type="application/json" id="data">${scriptJson(data)}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

const STYLES = `
:root{
  --bg:#f6f6f3;--surface:#ffffff;--ink:#1b1d1f;--muted:#6a717a;--line:#e5e5df;--soft:#f0f0eb;
  --accent:#2f5d8a;--good:#2e7d4f;--bad:#b3392f;
  --t0:#8fbfa0;--t1:#cfc871;--t2:#e6a957;--t3:#d9733f;--t4:#b3392f;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#131517;--surface:#1b1e21;--ink:#e7e7e2;--muted:#959ca5;--line:#2b2f34;--soft:#23272b;
  --accent:#86b5e0;--good:#6cc08b;--bad:#ef7a6e;
  --t0:#4f8a64;--t1:#a39d45;--t2:#c98a37;--t3:#cf6a3a;--t4:#d9544a;color-scheme:dark;}}
:root[data-theme="dark"]{
  --bg:#131517;--surface:#1b1e21;--ink:#e7e7e2;--muted:#959ca5;--line:#2b2f34;--soft:#23272b;
  --accent:#86b5e0;--good:#6cc08b;--bad:#ef7a6e;
  --t0:#4f8a64;--t1:#a39d45;--t2:#c98a37;--t3:#cf6a3a;--t4:#d9544a;color-scheme:dark;}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
.top,main{max-width:1080px;margin:0 auto;padding:0 16px}
.top{padding-top:36px;padding-bottom:4px}
.eyebrow{font:600 12px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(24px,4vw,32px);line-height:1.15;margin:8px 0 4px;letter-spacing:-.01em;overflow-wrap:anywhere}
h2{font-size:16px;margin:0 0 14px}
.muted{color:var(--muted);font-weight:500}
.arrow{color:var(--muted);font-weight:400}
.meta{margin:0;color:var(--muted);font-size:13px}
.note{margin:14px 0 0;padding:8px 12px;border-radius:8px;background:var(--soft);color:var(--muted);font-size:13px;max-width:80ch}
.note.warn{color:var(--ink);box-shadow:inset 3px 0 var(--t3)}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:20px}
@media (max-width:820px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:0}
.card-label{font-size:13px;color:var(--muted)}
.card-value{font-size:30px;font-weight:650;line-height:1.15;margin:4px 0}
.card-value .of{font-size:16px;color:var(--muted);font-weight:500}
.card-sub{font-size:13px;display:flex;flex-wrap:wrap;gap:4px 10px}
section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:12px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
.stack{min-width:0}
@media (max-width:820px){.cols{grid-template-columns:minmax(0,1fr);gap:0}}
.hint{margin:-8px 0 12px;color:var(--muted);font-size:12px;display:flex;align-items:center;gap:6px}
.was-key{display:inline-block;width:2px;height:12px;background:var(--ink);opacity:.55}
.barrow{display:flex;gap:12px;align-items:center;margin-bottom:8px}
.barlabel{flex:0 0 52px;font-size:12px;color:var(--muted)}
.bar{flex:1;display:flex;height:28px;border-radius:7px;overflow:hidden;background:var(--soft);min-width:0}
.seg{display:flex;align-items:center;justify-content:center;font:600 12px var(--mono);color:#1b1d1f;min-width:0}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none;background:var(--line)}
.tone0{background:var(--t0)}.tone1{background:var(--t1)}.tone2{background:var(--t2)}.tone3{background:var(--t3)}.tone4{background:var(--t4)}
.seg.tone3,.seg.tone4{color:#fff}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px;margin:12px 0 0;padding:0;font-size:13px;color:var(--muted)}
.legend li{display:flex;align-items:center;gap:6px}
.legend b{color:var(--ink)}
.delta{font-size:12px;font-weight:600;white-space:nowrap}
.delta.good{color:var(--good)}.delta.bad{color:var(--bad)}.delta.neutral{color:var(--accent)}.delta.flat{color:var(--muted);font-weight:500}
table{border-collapse:collapse;width:100%}
.fields th,.errors th{text-align:left;font-weight:500;padding:7px 12px 7px 0;white-space:nowrap;font-size:14px}
.errors th{display:flex;align-items:center;gap:8px}
.fields td,.errors td{padding:7px 0 7px 10px}
.errors tr.gone{opacity:.5}
.num{text-align:right;white-space:nowrap;font-size:13px}
.meter{width:100%;min-width:60px}
.track{position:relative;display:block;height:8px;border-radius:4px;background:var(--soft)}
.fill{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--accent)}
.was{position:absolute;top:-3px;width:2px;height:14px;background:var(--ink);opacity:.55;transform:translateX(-1px)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.tile{background:var(--soft);border-radius:10px;padding:10px 12px;min-width:0}
.tile-label{font-size:12px;color:var(--muted)}
.tile-value{font-size:22px;font-weight:650;line-height:1.25}
.tickets-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.count{margin:0;color:var(--muted);font-size:13px}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px}
.search{flex:1 1 200px}
.search input{width:100%;font:inherit;font-size:14px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--ink)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips button{font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);cursor:pointer;min-height:34px}
.chips button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--bg)}
.chips button .n{opacity:.7;margin-left:4px}
.search input:focus-visible,button:focus-visible,.item:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.list{list-style:none;margin:0;padding:0}
.item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 14px;align-items:start;padding:12px 10px;border-top:1px solid var(--line);cursor:pointer;border-radius:8px}
.item:hover{background:var(--soft)}
.item[aria-expanded="true"]{background:var(--soft);border-bottom-left-radius:0;border-bottom-right-radius:0}
.sev{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 7px;border-radius:12px;font:600 12px var(--mono);color:#1b1d1f}
.sev.tone3,.sev.tone4{color:#fff}
.body{min-width:0}
.msg{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.item[aria-expanded="true"] .msg{display:block;white-space:pre-wrap}
.sub{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;font-size:12px;color:var(--muted)}
.id{font-family:var(--mono)}
.tag{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
.tag.worse{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.tag.better{color:var(--good);background:color-mix(in srgb,var(--good) 14%,transparent)}
.tag.changed{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.mistake{padding:1px 8px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);white-space:nowrap}
.more{color:var(--muted)}
.detail{padding:4px 10px 16px 58px;background:var(--soft);border-bottom-left-radius:8px;border-bottom-right-radius:8px;font-size:14px}
.diff{width:auto;min-width:min(100%,360px)}
.diff th,.diff td{text-align:left;padding:5px 18px 5px 0;vertical-align:top}
.diff thead th{font-size:12px;color:var(--muted);font-weight:500}
.diff tbody th{font-weight:500;white-space:nowrap}
.diff .off{color:var(--bad);font-weight:600}
.diff .ok{color:var(--good)}
.linkish{font:inherit;font-size:13px;background:none;border:0;padding:6px 0;color:var(--accent);cursor:pointer}
details{margin-top:6px;font-size:13px;color:var(--muted)}
summary{cursor:pointer;padding:4px 0}
.answers{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px}
.answers b{color:var(--ink);font-weight:600}
.allgood{color:var(--good);margin:6px 0}
.empty{padding:28px 10px;color:var(--muted);text-align:center;border-top:1px solid var(--line)}
main{padding-bottom:40px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){
  section{padding:16px}
  .fields tr,.errors tr{display:grid;align-items:center;gap:2px 10px;padding:6px 0}
  .fields tr{grid-template-columns:minmax(0,1fr) auto auto}
  .errors tr{grid-template-columns:minmax(0,1fr) auto auto}
  .fields th,.errors th{grid-column:1/-1;padding:0;white-space:normal;overflow-wrap:anywhere}
  .fields td,.errors td{padding:0}
  .meter{min-width:0}
  .item{grid-template-columns:auto minmax(0,1fr);padding:12px 6px}
  .item .end{grid-column:2;justify-self:start}
  .detail{padding:4px 6px 14px}
  .diff{min-width:0;width:100%}
  .diff th,.diff td{padding-right:10px;overflow-wrap:anywhere}
}
`;

/** Browser side: filters and expands the ticket list. Plain DOM, no dependencies. */
const CLIENT = `
(() => {
  const data = JSON.parse(document.getElementById("data").textContent);
  const levels = data.levels;
  const label = (name) => data.labels[name] || name;
  const tone = (level) => {
    const index = levels.indexOf(level);
    return levels.length <= 1 || index < 0 ? 0 : Math.round((index / (levels.length - 1)) * 4);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const show = (value) => {
    if (value === null || value === undefined) return "—";
    if (value === true) return "yes";
    if (value === false) return "no";
    if (typeof value === "string") return value.replace(/_/g, " ");
    return String(value);
  };
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  };
  const changeOf = (row) => {
    if (!row.base) return "";
    if (row.severity > row.base.severity) return "worse";
    if (row.severity < row.base.severity) return "better";
    return same(row.actual, row.base.actual) ? "" : "changed";
  };

  const rows = data.rows.map((row) => ({
    ...row,
    change: changeOf(row),
    hay: [row.id, row.text || row.preview, ...row.errors, ...row.errors.map(label)].join(" ").toLowerCase(),
  }));
  // Worst first, counting what a ticket was before as well as now, so a fixed critical sits near the top.
  const worst = (row) => Math.max(row.severity, row.base ? row.base.severity : -Infinity);
  const shift = (row) => (row.base ? row.severity - row.base.severity : 0);
  rows.sort((a, b) => worst(b) - worst(a) || shift(b) - shift(a) || b.severity - a.severity || a.id.localeCompare(b.id));

  const clean = levels[0] ?? 0;
  const views = data.compared
    ? [
        ["all", "All", () => true],
        ["worse", "Worse", (row) => row.change === "worse"],
        ["better", "Better", (row) => row.change === "better"],
        ["changed", "Any change", (row) => Boolean(row.change)],
      ]
    : [
        ["mistakes", "With mistakes", (row) => row.severity > clean],
        ["all", "All", () => true],
      ];
  const state = { q: "", view: views[0][0], open: new Set() };
  const viewBox = document.getElementById("views");
  for (const [key, text, test] of views) {
    const button = el("button", { type: "button", "aria-pressed": String(key === state.view) }, text, el("span", { class: "n", text: String(rows.filter(test).length) }));
    button.addEventListener("click", () => {
      state.view = key;
      for (const other of viewBox.children) other.setAttribute("aria-pressed", String(other === button));
      render();
    });
    viewBox.append(button);
  }
  document.getElementById("q").addEventListener("input", (event) => {
    state.q = event.target.value.trim().toLowerCase();
    render();
  });

  function detail(row) {
    const box = el("div", { class: "detail" });
    const wrong = data.fields.filter((field) => !same(row.expected[field], row.actual[field]) || (row.base && !same(row.expected[field], row.base.actual[field])));
    const table = (fields) => {
      const head = el("tr", {}, el("th", {}), el("th", { text: "Should be" }), el("th", { text: data.compared ? "Now" : "Got" }));
      if (data.compared) head.append(el("th", { text: "Before" }));
      const body = el("tbody");
      for (const field of fields) {
        const expected = row.expected[field];
        const tr = el("tr", {}, el("th", { text: label(field) }), el("td", { text: show(expected) }));
        const now = row.actual[field];
        tr.append(el("td", { class: same(expected, now) ? "ok" : "off", text: show(now) }));
        if (data.compared) {
          const was = row.base ? row.base.actual[field] : undefined;
          tr.append(el("td", { class: !row.base ? "" : same(expected, was) ? "ok" : "off", text: row.base ? show(was) : "—" }));
        }
        body.append(tr);
      }
      return el("table", { class: "diff" }, el("thead", {}, head), body);
    };
    if (wrong.length) box.append(table(wrong));
    else box.append(el("p", { class: "allgood", text: "Every decision matched." }));
    const others = data.fields.filter((field) => !wrong.includes(field));
    if (others.length && wrong.length) {
      const more = el("button", { type: "button", class: "linkish", text: "Show all " + data.fields.length + " decisions" });
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        box.replaceChild(table(data.fields), box.querySelector("table"));
        more.remove();
      });
      box.append(more);
    }
    const answers = el("div", { class: "answers" });
    for (const [name, value] of Object.entries(row.answers)) answers.append(el("span", {}, label(name) + " ", el("b", { text: typeof value === "string" ? show(value) : String(value) })));
    box.append(el("details", {}, el("summary", { text: "Model's raw answers" }), answers));
    box.addEventListener("click", (event) => event.stopPropagation());
    return el("li", {}, box);
  }

  function render() {
    const list = document.getElementById("rows");
    list.replaceChildren();
    const test = views.find(([key]) => key === state.view)[2];
    const shown = rows.filter((row) => test(row) && (!state.q || row.hay.includes(state.q)));
    document.getElementById("count").textContent = shown.length + " of " + rows.length + " shown · click one for details";
    if (!shown.length) {
      list.append(el("li", { class: "empty", text: "No tickets here." }));
      return;
    }
    for (const row of shown) {
      const open = state.open.has(row.id);
      const sev = el("span", { class: "sev tone" + tone(row.severity), title: data.names[row.severity] || "severity " + row.severity, text: String(row.severity) });
      const sub = el("div", { class: "sub" }, el("span", { class: "id", text: row.id }));
      for (const code of row.errors.slice(0, 2)) sub.append(el("span", { class: "mistake", title: code, text: label(code) }));
      if (row.errors.length > 2) sub.append(el("span", { class: "more", text: "+" + (row.errors.length - 2) + " more" }));
      const end = el("div", { class: "end" });
      if (row.change) end.append(el("span", { class: "tag " + row.change, text: row.change === "changed" ? "changed" : row.change + " (" + row.base.severity + " → " + row.severity + ")" }));
      const item = el("li", { class: "item", tabindex: "0", role: "button", "aria-expanded": String(open) }, sev, el("div", { class: "body" }, el("div", { class: "msg", text: row.text || row.preview }), sub), end);
      const toggle = () => {
        if (state.open.has(row.id)) state.open.delete(row.id);
        else state.open.add(row.id);
        render();
        const again = list.querySelector('[data-id="' + CSS.escape(row.id) + '"]');
        if (again) again.focus();
      };
      item.dataset.id = row.id;
      item.addEventListener("click", toggle);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
      list.append(item);
      if (open) list.append(detail(row));
    }
  }
  render();
})();
`;
