import { describe, expect, it } from "vitest";
import { humanize, renderReport, scriptJson, severityNames, severityTone } from "../src/html.js";
import type { PracticeReport, PracticeRow } from "../src/report.js";

const row = (id: string, severity: number, human: boolean, text = "hello"): PracticeRow => ({
  id,
  preview: text.slice(0, 120),
  text,
  severity,
  errors: severity ? ["missed_human"] : [],
  expected: { human: true },
  actual: { human },
  answers: { human: human ? 0.9 : 0.1 },
});

const report = (label: string, rows: PracticeRow[]): PracticeReport => ({
  label,
  at: "2026-10-19T12:00:00.000Z",
  project: "test",
  variant: null,
  datasets: ["tickets.json"],
  provider: "fake m",
  calls: 0,
  cacheHits: rows.length,
  spentUsd: 0,
  failures: [],
  summary: {
    cases: rows.length,
    fieldAccuracy: { human: rows.filter((r) => r.actual.human).length / rows.length },
    metrics: { missed: rows.filter((r) => !r.actual.human).length },
    metricKinds: { missed: "count" },
    metricBetter: { missed: "lower" },
    bySeverity: { "0": rows.filter((r) => r.severity === 0).length, "3": rows.filter((r) => r.severity === 3).length },
    errorCodes: rows.some((r) => r.severity) ? { missed_human: rows.filter((r) => r.severity).length } : {},
    costUsd: 0,
  },
  severityWeights: { missed_human: 3 },
  rows,
});

describe("html report", () => {
  it("keeps customer text from closing the data script", () => {
    const hostile = 'x</script><script>alert(1)</script>';
    const html = renderReport(report("run", [row("t1", 0, true, hostile)]));
    expect(html).not.toContain("</script><script>alert(1)");
    expect(scriptJson({ a: "</script>\u2028" })).toBe('{"a":"\\u003c/script>\\u2028"}');
    expect(JSON.parse(scriptJson({ a: "</script>" }))).toEqual({ a: "</script>" });
  });

  it("escapes labels in the page and loads nothing from the network", () => {
    const html = renderReport(report("<b>run</b>", [row("t1", 0, true)]));
    expect(html).toContain("&lt;b&gt;run&lt;/b&gt;");
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/@import|url\(/);
  });

  it("counts worse and better tickets against a baseline and colors deltas by direction", () => {
    const before = report("before", [row("a", 3, false), row("b", 0, true), row("c", 0, true)]);
    const after = report("after", [row("a", 0, true), row("b", 3, false), row("c", 3, false)]);
    const html = renderReport(after, before);
    expect(html).toContain('<div class="card-value">3</div><div class="card-sub"><span class="delta good">1 better</span> <span class="delta bad">2 worse</span>');
    // `missed` went up and lower is better.
    expect(html).toContain('<span class="delta bad">▲ 1</span>');
    expect(html).toContain("<title>before → after · ticket-proof</title>");
  });

  it("warns when the runs did not score the same tickets", () => {
    const html = renderReport(report("after", [row("a", 0, true)]), report("before", [row("z", 0, true)]));
    expect(html).toContain("scored different tickets");
  });

  it("maps any set of severity levels onto five tones", () => {
    expect([0, 1, 2, 3, 4].map((level) => severityTone(level, [0, 1, 2, 3, 4]))).toEqual([0, 1, 2, 3, 4]);
    expect([0, 10].map((level) => severityTone(level, [0, 10]))).toEqual([0, 4]);
    expect(severityTone(5, [0, 1])).toBe(0);
    expect(severityNames([0, 1, 2, 3, 4])).toEqual({ 0: "No mistake", 1: "Minor", 2: "Moderate", 3: "Serious", 4: "Critical" });
    expect(severityNames([0, 10])).toEqual({ 0: "No mistake", 10: "Critical" });
  });

  it("turns code names into labels", () => {
    expect(humanize("criticalHumanRecall")).toBe("Critical human recall");
    expect(humanize("missed_human")).toBe("Missed human");
    expect(humanize("api_issue")).toBe("API issue");
  });
});
