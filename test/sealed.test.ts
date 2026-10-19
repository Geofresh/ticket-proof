import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateTicket, runTickets } from "../src/run.js";
import { loadTickets } from "../src/project.js";
import { assertPracticeFile, assertSealedHash, errorKind, recordGrade, recordPractice, SealedError, sealFile, toSealedTotals } from "../src/sealed.js";
import { LeakageError } from "../src/leakage.js";
import { CacheMissError, SpendCapError } from "../src/providers/index.js";
import { ProviderHttpError } from "../src/providers/types.js";
import { answers, FakeProvider, project, tmpDir, writeTickets } from "./helpers.js";

const rows = [
  { id: "t1", input: { message: "SECRET-ONE refund please", vip: false }, facts: { topic: "billing", urgent: true } },
  { id: "t2", input: { message: "SECRET-TWO hello", vip: true }, facts: { topic: "other", urgent: false } },
];

describe("seal", () => {
  it("writes the hash next to the file and makes it read-only", () => {
    const dir = tmpDir();
    const file = writeTickets(dir, "next/holdout.json", rows);
    const hash = sealFile(file, path.join(dir, "runs"));
    expect(fs.readFileSync(path.join(dir, "next", "SHA256"), "utf8")).toBe(`${hash}  holdout.json\n`);
    expect(fs.statSync(file).mode & 0o222).toBe(0);
    expect(assertSealedHash(file)).toBe(hash);
  });

  it("refuses a file you already practiced on", () => {
    const dir = tmpDir();
    const file = writeTickets(dir, "set/tickets.json", rows);
    recordPractice(file, path.join(dir, "runs"));
    expect(() => sealFile(file, path.join(dir, "runs"))).toThrow(/not blind/);
  });

  it("refuses to re-seal a holdout that changed", () => {
    const dir = tmpDir();
    const file = writeTickets(dir, "set/holdout.json", rows);
    sealFile(file, path.join(dir, "runs"));
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, JSON.stringify(rows.slice(0, 1)));
    expect(() => sealFile(file, path.join(dir, "runs"))).toThrow(/different hash/);
  });
});

describe("grade guards", () => {
  it("refuses a missing registry or a hash mismatch", () => {
    const dir = tmpDir();
    const file = writeTickets(dir, "set/holdout.json", rows);
    expect(() => assertSealedHash(file)).toThrow(SealedError);
    fs.writeFileSync(path.join(dir, "set", "SHA256"), `${"0".repeat(64)}  holdout.json\n`);
    expect(() => assertSealedHash(file)).toThrow(/does not match/);
  });

  it("counts how often a holdout was graded", () => {
    const runs = path.join(tmpDir(), "runs");
    expect(recordGrade("a".repeat(64), runs)).toBe(0);
    expect(recordGrade("a".repeat(64), runs)).toBe(1);
  });

  it("returns totals only: no ids, messages, decisions or reasons", async () => {
    const dir = tmpDir();
    const file = writeTickets(dir, "set/holdout.json", rows);
    sealFile(file, path.join(dir, "runs"));
    const provider = new FakeProvider("m", (input) => answers(String(input.message).includes("refund") ? "billing" : "other", 0.1));
    const { scored, failures } = await runTickets(loadTickets(file), (ticket) => evaluateTicket(project, ticket, provider));
    const totals = toSealedTotals(project, scored, [...failures.map((f) => f.error), new Error("t1 SECRET-ONE exploded")]);
    expect(Object.keys(totals).sort()).toEqual(
      ["bySeverity", "cases", "costUsd", "errorCodes", "errorKinds", "errors", "fieldAccuracy", "metricKinds", "metrics"].sort(),
    );
    const text = JSON.stringify(totals);
    for (const leak of ["t1", "t2", "SECRET", "refund please", "message"]) expect(text).not.toContain(leak);
    expect(totals).toMatchObject({ cases: 2, errors: 1, errorKinds: { other: 1 }, metrics: { humanRecall: 0 }, errorCodes: { human_mismatch: 2 } });
  });

  it("names failures by kind, never by content", () => {
    expect(errorKind(new SpendCapError(5, 5))).toBe("spend_cap");
    expect(errorKind(new LeakageError("leaked key input.expected"))).toBe("leakage");
    expect(errorKind(new CacheMissError("abc"))).toBe("cache_miss");
    expect(errorKind(new ProviderHttpError(429, "slow down, ticket t1"))).toBe("provider_http_429");
    expect(errorKind(new Error("missing answer: needs_person"))).toBe("answer:needs_person");
    expect(errorKind(new Error("ticket t1 says SECRET"))).toBe("other");
  });
});

describe("practice refuses holdouts", () => {
  it("by registered hash anywhere in the checkout, even renamed", () => {
    const root = tmpDir();
    const sealed = writeTickets(root, "data/next/holdout.json", rows);
    sealFile(sealed, path.join(root, "runs"));
    const copy = path.join(root, "data", "practice-copy.json");
    fs.copyFileSync(sealed, copy);
    expect(() => assertPracticeFile(copy, root)).toThrow(/sealed holdout/);
  });

  it("through a symlink", () => {
    const root = tmpDir();
    const sealed = writeTickets(root, "data/next/holdout.json", rows);
    sealFile(sealed, path.join(root, "runs"));
    const link = path.join(root, "innocent.json");
    fs.symlinkSync(sealed, link);
    expect(() => assertPracticeFile(link, root)).toThrow(SealedError);
  });

  it("by name: a sealed* folder or a holdout* file, sealed or not", () => {
    const root = tmpDir();
    expect(() => assertPracticeFile(writeTickets(root, "sealed-v2/tickets.json", rows), root)).toThrow(/looks like a holdout/);
    expect(() => assertPracticeFile(writeTickets(root, "data/holdout-new.json", rows), root)).toThrow(/looks like a holdout/);
    expect(() => assertPracticeFile(writeTickets(root, "data/dev.json", rows), root)).not.toThrow();
  });
});
