import path from "node:path";
import { loadEnv, ROOT } from "../env.js";
import type { ProviderDefaults } from "../project.js";
import { CachedProvider, SpendCappedProvider } from "./cache.js";
import { DEFAULT_BASE_URL, OpenAICompatibleProvider } from "./openai-compatible.js";
import { OpenRouterDecisionsProvider } from "./openrouter-decisions.js";
import { SpendLedger } from "./spend.js";
import type { Pricing, Provider } from "./types.js";

export type ProviderOptions = {
  /** Where responses are cached. null = no cache (sealed grading). */
  cacheDir: string | null;
  /** Never call the API: a cache miss is an error. */
  offline: boolean;
  defaults?: ProviderDefaults;
  env?: Record<string, string | undefined>;
  ledgerFile?: string;
};

export type Built = { provider: Provider; cache: CachedProvider | null; paid: SpendCappedProvider | null; ledger: SpendLedger | null; describe: string };

function pricing(env: Record<string, string | undefined>): Pricing {
  const inPerM = env.HARNESS_PRICE_IN_PER_M;
  const outPerM = env.HARNESS_PRICE_OUT_PER_M;
  if (inPerM === undefined && outPerM === undefined) return null;
  return { inPerM: Number(inPerM ?? 0), outPerM: Number(outPerM ?? 0) };
}

/**
 * Pick the provider from the environment (or `.env` in this checkout), falling back to the
 * project's defaults. Always wrapped in the response cache; live calls also go through the spend cap.
 */
export function buildProvider(options: ProviderOptions): Built {
  const env = options.env ?? loadEnv();
  const kind = env.HARNESS_PROVIDER || options.defaults?.provider || "openrouter-decisions";
  const model = env.HARNESS_MODEL || options.defaults?.model;
  if (!model) throw new Error("no model: set HARNESS_MODEL or the project's defaults.model");
  if (kind !== "openrouter-decisions" && kind !== "openai-compatible") throw new Error(`unknown HARNESS_PROVIDER ${kind}`);
  const baseUrl = env.HARNESS_BASE_URL || options.defaults?.baseUrl || DEFAULT_BASE_URL;
  const describe = kind === "openai-compatible" ? `${kind} ${model} at ${baseUrl}` : `${kind} ${model}`;
  if (options.offline) {
    if (!options.cacheDir) throw new Error("offline needs a response cache");
    const cache = new CachedProvider(kind, model, options.cacheDir, null);
    return { provider: cache, cache, paid: null, ledger: null, describe };
  }

  const fallback = Number(env.HARNESS_FALLBACK_CALL_USD ?? 0.05);
  const price = pricing(env);
  let live: Provider;
  if (kind === "openrouter-decisions") {
    const key = env.OPENROUTER_API_KEY || env.HARNESS_API_KEY;
    if (!key) throw new Error("set OPENROUTER_API_KEY (environment or .env in this checkout); practice and demo can run from the cache with --offline");
    live = new OpenRouterDecisionsProvider(model, key, price, fallback);
  } else {
    const isOpenRouter = new URL(baseUrl).hostname === "openrouter.ai";
    const key = env.HARNESS_API_KEY || (isOpenRouter ? env.OPENROUTER_API_KEY : undefined) || null;
    if (isOpenRouter && !key) throw new Error("set OPENROUTER_API_KEY or HARNESS_API_KEY; practice and demo can run from the cache with --offline");
    live = new OpenAICompatibleProvider(model, key, baseUrl, price, fallback);
  }
  const ledger = new SpendLedger(options.ledgerFile ?? path.join(ROOT, "runs", "spend.json"), Number(env.HARNESS_SPEND_CAP_USD ?? 5));
  const paid = new SpendCappedProvider(live, ledger);
  if (!options.cacheDir) return { provider: paid, cache: null, paid, ledger, describe };
  const cache = new CachedProvider(kind, model, options.cacheDir, paid);
  return { provider: cache, cache, paid, ledger, describe };
}

export { CachedProvider, CacheMissError, cacheKey, SpendCappedProvider } from "./cache.js";
export { SpendCapError, SpendLedger } from "./spend.js";
export type { Provider, ProviderResult } from "./types.js";
