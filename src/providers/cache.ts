import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateAnswers, type Questions, type RawAnswers } from "../questions.js";
import { PaidParseError, type Provider, type ProviderResult } from "./types.js";
import { SpendLedger } from "./spend.js";

export class CacheMissError extends Error {
  constructor(key: string) {
    super(`no cached response for request ${key.slice(0, 12)} and live calls are off`);
    this.name = "CacheMissError";
  }
}

/**
 * Cache key: the API shape, the requested model, the exact input and the exact questions. Change
 * any question's wording and every ticket is a new request; change only policy code and every
 * ticket rescores from the cache for free.
 */
export function cacheKey(providerId: string, model: string, input: Record<string, unknown>, questions: Questions): string {
  return crypto.createHash("sha256").update(JSON.stringify({ provider: providerId, model, input, questions })).digest("hex");
}

type Stored = { key: string; provider: string; model: string; servedModel: string; at: string; costUsd: number; answers: RawAnswers };

/** Stop before a paid call once the ledger reaches its cap, and book every paid call, including unreadable replies. */
export class SpendCappedProvider implements Provider {
  calls = 0;

  constructor(
    private inner: Provider,
    private ledger: SpendLedger,
  ) {}

  get id() {
    return this.inner.id;
  }

  get model() {
    return this.inner.model;
  }

  async ask(input: Record<string, unknown>, questions: Questions): Promise<ProviderResult> {
    this.ledger.assertCanSpend();
    this.calls += 1;
    try {
      const result = await this.inner.ask(input, questions);
      this.ledger.add(result.costUsd, `${this.inner.id} ${this.inner.model}`);
      return result;
    } catch (error) {
      if (error instanceof PaidParseError) this.ledger.add(error.costUsd, `${this.inner.id} ${this.inner.model} (unreadable reply)`);
      throw error;
    }
  }
}

/**
 * Reads and writes one JSON file per request. With no `live` provider (offline), a miss is an
 * error and nothing is called.
 */
export class CachedProvider implements Provider {
  hits = 0;
  misses = 0;

  constructor(
    readonly id: string,
    readonly model: string,
    private dir: string,
    private live: Provider | null,
  ) {
    if (live && (live.id !== id || live.model !== model)) throw new Error("cache and live provider disagree on provider or model");
  }

  async ask(input: Record<string, unknown>, questions: Questions): Promise<ProviderResult> {
    const key = cacheKey(this.id, this.model, input, questions);
    const file = path.join(this.dir, `${key}.json`);
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Stored;
      this.hits += 1;
      return { answers: validateAnswers(questions, stored.answers), servedModel: stored.servedModel, costUsd: 0, latencyMs: 0, cached: true };
    }
    this.misses += 1;
    if (!this.live) throw new CacheMissError(key);
    const result = await this.live.ask(input, questions);
    validateAnswers(questions, result.answers);
    const stored: Stored = {
      key,
      provider: this.id,
      model: this.model,
      servedModel: result.servedModel,
      at: new Date().toISOString(),
      costUsd: result.costUsd,
      answers: result.answers,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    return result;
  }
}
