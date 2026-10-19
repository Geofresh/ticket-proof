import type { Questions, RawAnswers } from "../questions.js";

export type ProviderResult = {
  answers: RawAnswers;
  /** The model the API says served the request. */
  servedModel: string;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
};

/** Anything that can answer the questions about one input. */
export interface Provider {
  /** Stable name of the API shape, part of the cache key. */
  readonly id: string;
  readonly model: string;
  ask(input: Record<string, unknown>, questions: Questions): Promise<ProviderResult>;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`provider HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ProviderHttpError";
  }
}

/** The call was paid for but the reply could not be read. Carries the cost so the ledger books it. */
export class PaidParseError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
    this.name = "PaidParseError";
  }
}

export function parsePaid<T>(costUsd: number, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new PaidParseError(error instanceof Error ? error.message : String(error), costUsd);
  }
}

const RETRY = new Set([408, 429, 500, 502, 503, 504]);

/** POST JSON with three attempts on timeouts and retryable statuses. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 90_000): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new ProviderHttpError(response.status, text);
        if (!RETRY.has(response.status)) throw lastError;
        continue;
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProviderHttpError && !RETRY.has(error.status)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("provider request failed");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

export function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, child] of Object.entries(asRecord(value))) if (typeof child === "number") out[key] = child;
  return out;
}

export type Pricing = { inPerM: number; outPerM: number } | null;

/** Reported cost if the API gives one, else tokens at the configured price, else a flat fallback. */
export function costOf(usage: Record<string, unknown>, pricing: Pricing, fallbackUsd: number): number {
  for (const key of ["cost", "total_cost", "cost_usd"]) {
    const value = num(usage[key]);
    if (Number.isFinite(value)) return value;
  }
  if (pricing) {
    const input = num(usage.input_tokens ?? usage.prompt_tokens);
    const output = num(usage.output_tokens ?? usage.completion_tokens);
    if (Number.isFinite(input) || Number.isFinite(output)) {
      return ((Number.isFinite(input) ? input : 0) * pricing.inPerM + (Number.isFinite(output) ? output : 0) * pricing.outPerM) / 1_000_000;
    }
  }
  return fallbackUsd;
}
