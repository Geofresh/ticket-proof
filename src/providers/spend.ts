import fs from "node:fs";
import path from "node:path";

export class SpendCapError extends Error {
  constructor(spent: number, cap: number) {
    super(`spend cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}`);
    this.name = "SpendCapError";
  }
}

type Ledger = { totalUsd: number; events: { at: string; costUsd: number; note: string; totalUsd: number }[] };

/**
 * A file ledger with a hard cap. `assertCanSpend` runs before every paid request and stops once the
 * total reaches the cap. Requests already in flight still finish, so the overshoot is at most one
 * call per concurrent worker.
 */
export class SpendLedger {
  constructor(
    readonly file: string,
    readonly cap: number,
  ) {
    if (!(cap >= 0)) throw new Error("spend cap must be a number >= 0");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ totalUsd: 0, events: [] }, null, 2));
  }

  private read(): Ledger {
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as Ledger;
  }

  total(): number {
    return Number(this.read().totalUsd) || 0;
  }

  assertCanSpend(): void {
    const spent = this.total();
    if (spent >= this.cap) throw new SpendCapError(spent, this.cap);
  }

  add(costUsd: number, note: string): number {
    const ledger = this.read();
    ledger.totalUsd = Number(((ledger.totalUsd || 0) + costUsd).toFixed(6));
    ledger.events.push({ at: new Date().toISOString(), costUsd, note, totalUsd: ledger.totalUsd });
    fs.writeFileSync(this.file, JSON.stringify(ledger, null, 2));
    return ledger.totalUsd;
  }
}
