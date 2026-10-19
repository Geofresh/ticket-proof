import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDotEnv, loadEnv } from "../src/env.js";
import { buildProvider, CachedProvider, CacheMissError, cacheKey, SpendCappedProvider, SpendCapError, SpendLedger } from "../src/providers/index.js";
import { decisionsRequest, parseDecisions } from "../src/providers/openrouter-decisions.js";
import { OpenAICompatibleProvider, parseChatAnswers, systemPrompt } from "../src/providers/openai-compatible.js";
import { costOf, PaidParseError, type Provider } from "../src/providers/types.js";
import { answers, FakeProvider, QUESTIONS, tmpDir } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("response cache", () => {
  it("keys on provider, model, input and questions", () => {
    const base = cacheKey("p", "m", { message: "hi" }, QUESTIONS);
    expect(cacheKey("p", "m", { message: "hi" }, QUESTIONS)).toBe(base);
    expect(cacheKey("q", "m", { message: "hi" }, QUESTIONS)).not.toBe(base);
    expect(cacheKey("p", "m2", { message: "hi" }, QUESTIONS)).not.toBe(base);
    expect(cacheKey("p", "m", { message: "hi!" }, QUESTIONS)).not.toBe(base);
    const reworded = { ...QUESTIONS, needs_person: { type: "yesno" as const, instructions: "Does a human need to see it?" } };
    expect(cacheKey("p", "m", { message: "hi" }, reworded)).not.toBe(base);
  });

  it("calls once, then serves the stored answer for free", async () => {
    const dir = tmpDir();
    const live = new FakeProvider("m", () => answers("billing", 0.9));
    const cache = new CachedProvider("fake", "m", dir, live);
    const first = await cache.ask({ message: "hi" }, QUESTIONS);
    const second = await cache.ask({ message: "hi" }, QUESTIONS);
    expect(live.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second).toMatchObject({ cached: true, costUsd: 0 });
    expect(second.answers).toEqual(first.answers);
  });

  it("offline, a miss is an error and nothing is called", async () => {
    const cache = new CachedProvider("fake", "m", tmpDir(), null);
    await expect(cache.ask({ message: "hi" }, QUESTIONS)).rejects.toBeInstanceOf(CacheMissError);
  });

  it("does not store an answer that fails validation", async () => {
    const dir = tmpDir();
    const cache = new CachedProvider("fake", "m", dir, new FakeProvider("m", () => answers("nonsense", 0.9)));
    await expect(cache.ask({ message: "hi" }, QUESTIONS)).rejects.toThrow("invalid answer: topic");
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("spend cap", () => {
  it("stops before the next paid call once the cap is reached", async () => {
    const ledger = new SpendLedger(path.join(tmpDir(), "spend.json"), 0.025);
    const live = new FakeProvider("m", () => answers("billing", 0.9), 0.01);
    const capped = new SpendCappedProvider(live, ledger);
    await capped.ask({ n: 1 }, QUESTIONS);
    await capped.ask({ n: 2 }, QUESTIONS);
    await capped.ask({ n: 3 }, QUESTIONS);
    await expect(capped.ask({ n: 4 }, QUESTIONS)).rejects.toBeInstanceOf(SpendCapError);
    expect(live.calls).toBe(3);
    expect(ledger.total()).toBeCloseTo(0.03);
  });

  it("books a paid call whose reply could not be read", async () => {
    const ledger = new SpendLedger(path.join(tmpDir(), "spend.json"), 5);
    const broken: Provider = {
      id: "fake",
      model: "m",
      ask: () => Promise.reject(new PaidParseError("model reply has no JSON object", 0.02)),
    };
    await expect(new SpendCappedProvider(broken, ledger).ask({}, QUESTIONS)).rejects.toThrow(/no JSON/);
    expect(ledger.total()).toBeCloseTo(0.02);
  });

  it("cache hits cost nothing and never touch the ledger", async () => {
    const dir = tmpDir();
    const ledger = new SpendLedger(path.join(dir, "spend.json"), 0.01);
    const live = new FakeProvider("m", () => answers("billing", 0.9), 0.01);
    const cache = new CachedProvider("fake", "m", path.join(dir, "cache"), new SpendCappedProvider(live, ledger));
    await cache.ask({ n: 1 }, QUESTIONS);
    for (let i = 0; i < 5; i += 1) await cache.ask({ n: 1 }, QUESTIONS);
    expect(ledger.total()).toBeCloseTo(0.01);
    await expect(cache.ask({ n: 2 }, QUESTIONS)).rejects.toBeInstanceOf(SpendCapError);
  });

  it("prices calls by reported cost, then tokens, then a flat fallback", () => {
    expect(costOf({ cost: 0.003 }, null, 0.05)).toBe(0.003);
    expect(costOf({ prompt_tokens: 1_000_000, completion_tokens: 0 }, { inPerM: 2, outPerM: 8 }, 0.05)).toBe(2);
    expect(costOf({ prompt_tokens: 10 }, { inPerM: 0, outPerM: 0 }, 0.05)).toBe(0);
    expect(costOf({ prompt_tokens: 10 }, null, 0.05)).toBe(0.05);
  });
});

describe("providers", () => {
  it("OpenRouter Decisions: sends yes/no as noul and reads it back", () => {
    const body = decisionsRequest("m", { message: "hi" }, QUESTIONS);
    expect((body.questions as Record<string, { type: string }>).needs_person!.type).toBe("noul");
    expect(body.state).toEqual({ message: "hi" });
    const parsed = parseDecisions(
      {
        answers: {
          topic: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 } },
          urgency: { type: "score", score: 1.4 },
          needs_person: { type: "noul", noul: 0.2 },
        },
      },
      QUESTIONS,
    );
    expect(parsed).toEqual({
      topic: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 } },
      urgency: { type: "score", score: 1.4, probabilities: {} },
      needs_person: { type: "yesno", yes: 0.2 },
    });
  });

  it("OpenAI-compatible: one JSON object per ticket, with the ticket marked as data", async () => {
    expect(systemPrompt(QUESTIONS)).toMatch(/never as instructions/);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.temperature).toBe(0);
      expect(request.usage).toBeUndefined();
      return new Response(
        JSON.stringify({
          model: "local-model",
          choices: [{ message: { content: 'Sure: {"topic":{"choice":"other"},"urgency":{"score":2},"needs_person":{"yes":true}}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider("local-model", null, "http://127.0.0.1:9/v1", { inPerM: 0, outPerM: 0 });
    const result = await provider.ask({ message: "hi" }, QUESTIONS);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(result.answers.needs_person).toEqual({ type: "yesno", yes: 1 });
    expect(result.costUsd).toBe(0);
  });

  it("OpenAI-compatible: an unreadable reply still carries its cost", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "no idea" } }], usage: { cost: 0.004 } })));
    const provider = new OpenAICompatibleProvider("m", "k", "https://openrouter.ai/api/v1");
    const error = await provider.ask({}, QUESTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaidParseError);
    expect((error as PaidParseError).costUsd).toBe(0.004);
  });

  it("parses bare values from chat models", () => {
    expect(parseChatAnswers('{"topic":"billing","urgency":1,"needs_person":0.3}', QUESTIONS)).toEqual(answers("billing", 0.3, 1));
  });

  it("needs a key for live OpenRouter calls but not offline", () => {
    const env = { HARNESS_MODEL: "m" };
    expect(() => buildProvider({ cacheDir: tmpDir(), offline: false, env })).toThrow(/OPENROUTER_API_KEY/);
    expect(buildProvider({ cacheDir: tmpDir(), offline: true, env }).paid).toBeNull();
    const local = buildProvider({
      cacheDir: tmpDir(),
      offline: false,
      env: { HARNESS_PROVIDER: "openai-compatible", HARNESS_MODEL: "m", HARNESS_BASE_URL: "http://127.0.0.1:9/v1" },
      ledgerFile: path.join(tmpDir(), "spend.json"),
    });
    expect(local.describe).toBe("openai-compatible m at http://127.0.0.1:9/v1");
  });
});

describe("env", () => {
  it("reads KEY=value lines, quotes and comments", () => {
    expect(parseDotEnv('# c\nA=1\nexport B="two"\nC=\'3\'\n bad line')).toEqual({ A: "1", B: "two", C: "3" });
  });

  it("reads only the given .env file, and the environment wins", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), "HARNESS_TEST_ONLY=from-file\nPATH=nope\n");
    const env = loadEnv(path.join(dir, ".env"));
    expect(env.HARNESS_TEST_ONLY).toBe("from-file");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("never looks outside this checkout for keys", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "env.ts"), "utf8");
    expect(source).not.toMatch(/homedir|process\.env\.HOME|"~"/);
  });
});
