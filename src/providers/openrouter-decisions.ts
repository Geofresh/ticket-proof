import type { Answer, Questions, RawAnswers } from "../questions.js";
import { asRecord, costOf, num, parsePaid, numbers, postJson, type Pricing, type Provider, type ProviderResult } from "./types.js";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/**
 * The request body for OpenRouter's Decisions API (alpha). It takes structured questions natively;
 * its name for a yes/no question is `noul`. `input` is sent as `state`.
 */
export function decisionsRequest(model: string, input: Record<string, unknown>, questions: Questions): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    wire[name] = question.type === "yesno" ? { ...question, type: "noul" } : question;
  }
  return { model, state: input, questions: wire };
}

export function parseDecisions(body: Record<string, unknown>, questions: Questions): RawAnswers {
  const raw = asRecord(body.answers ?? asRecord(body.data).answers);
  const out: RawAnswers = {};
  for (const [name, question] of Object.entries(questions)) {
    const block = asRecord(raw[name]);
    let answer: Answer;
    if (question.type === "choice") {
      answer = { type: "choice", choice: String(block.choice ?? ""), probabilities: numbers(block.probabilities) };
    } else if (question.type === "score") {
      answer = { type: "score", score: num(block.score), probabilities: numbers(block.probabilities) };
    } else {
      answer = { type: "yesno", yes: num(block.noul ?? block.yes) };
    }
    out[name] = answer;
  }
  return out;
}

export class OpenRouterDecisionsProvider implements Provider {
  readonly id = "openrouter-decisions";

  constructor(
    readonly model: string,
    private apiKey: string,
    private pricing: Pricing = null,
    private fallbackUsd = 0.05,
    private url = DECISIONS_URL,
  ) {}

  async ask(input: Record<string, unknown>, questions: Questions): Promise<ProviderResult> {
    const started = Date.now();
    const body = await postJson(
      this.url,
      { Authorization: `Bearer ${this.apiKey}`, "X-Title": "ticket-proof" },
      decisionsRequest(this.model, input, questions),
    );
    const costUsd = costOf(asRecord(body.usage), this.pricing, this.fallbackUsd);
    return {
      answers: parsePaid(costUsd, () => parseDecisions(body, questions)),
      servedModel: typeof body.model === "string" ? body.model : this.model,
      costUsd,
      latencyMs: Date.now() - started,
      cached: false,
    };
  }
}
