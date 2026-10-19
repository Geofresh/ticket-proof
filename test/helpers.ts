import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineProject, type Decision } from "../src/project.js";
import type { Questions, RawAnswers } from "../src/questions.js";
import type { Provider, ProviderResult } from "../src/providers/types.js";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
}

export const QUESTIONS: Questions = {
  topic: { type: "choice", instructions: "What is it about?", criteria: { billing: "Money.", other: "Anything else." } },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["Routine.", "Minor.", "Critical."] },
  needs_person: { type: "yesno", instructions: "Does a person need to see it?" },
};

export type Input = { message: string; vip: boolean };
export type Facts = { topic: string; urgent: boolean };
export type D = Decision & { topic: string; human: boolean };

export const project = defineProject<Input, Facts, D>({
  name: "toy",
  questions: QUESTIONS,
  policy: (a, input) => ({ topic: a.choice("topic"), human: input.vip || a.yes("needs_person") >= 0.5 }),
  expected: (facts) => ({ topic: facts.topic, human: facts.urgent }),
  severity: { topic_mismatch: 1, human_mismatch: 4 },
  metrics: { humanRecall: { where: (e) => e.human, hit: (_e, a) => a.human } },
  leakage: { freeText: ["message"], forbiddenTokens: ["needs_person"] },
});

export function answers(topic: string, yes: number, urgency = 1): RawAnswers {
  return {
    topic: { type: "choice", choice: topic, probabilities: {} },
    urgency: { type: "score", score: urgency, probabilities: {} },
    needs_person: { type: "yesno", yes },
  };
}

/** A fake API: answers from a function, counts calls, charges a fixed cost. */
export class FakeProvider implements Provider {
  readonly id = "fake";
  calls = 0;
  seen: unknown[] = [];
  constructor(
    readonly model: string,
    private respond: (input: Record<string, unknown>) => RawAnswers,
    private cost = 0.01,
  ) {}
  async ask(input: Record<string, unknown>): Promise<ProviderResult> {
    this.calls += 1;
    this.seen.push(input);
    return { answers: this.respond(input), servedModel: this.model, costUsd: this.cost, latencyMs: 1, cached: false };
  }
}

export function writeTickets(dir: string, name: string, rows: unknown[]): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return file;
}
