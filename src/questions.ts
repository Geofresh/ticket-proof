import fs from "node:fs";

/**
 * What the model is asked. Three kinds:
 * - choice: pick one key of `criteria` (a category name and what it means).
 * - score: a level 0..n-1, one `criteria` line per level. The model may return a fractional score.
 * - yesno: a probability that the answer is yes.
 */
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type YesNoQuestion = { type: "yesno"; instructions: string };
export type Question = ChoiceQuestion | ScoreQuestion | YesNoQuestion;
export type Questions = Record<string, Question>;

export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number> };
export type ScoreAnswer = { type: "score"; score: number; probabilities: Record<string, number> };
export type YesNoAnswer = { type: "yesno"; yes: number };
export type Answer = ChoiceAnswer | ScoreAnswer | YesNoAnswer;
export type RawAnswers = Record<string, Answer>;

const NAME = /^[a-z][a-z0-9_]*$/;

export function validateQuestions(value: unknown): Questions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("questions must be an object of name -> question");
  const out: Questions = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!NAME.test(name)) throw new Error(`question name ${JSON.stringify(name)} must be snake_case`);
    const q = raw as Record<string, unknown>;
    if (!q || typeof q.instructions !== "string" || !q.instructions.trim()) throw new Error(`question ${name}: instructions are required`);
    if (q.type === "choice") {
      const criteria = q.criteria as Record<string, unknown> | undefined;
      if (!criteria || typeof criteria !== "object" || Array.isArray(criteria) || Object.keys(criteria).length < 2) {
        throw new Error(`question ${name}: a choice needs at least two criteria`);
      }
      for (const [key, text] of Object.entries(criteria)) {
        if (typeof text !== "string") throw new Error(`question ${name}: criterion ${key} must be text`);
      }
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.some((line) => typeof line !== "string")) {
        throw new Error(`question ${name}: a score needs one criteria line per level, at least two`);
      }
    } else if (q.type !== "yesno") {
      throw new Error(`question ${name}: type must be choice, score or yesno`);
    }
    out[name] = raw as Question;
  }
  if (Object.keys(out).length === 0) throw new Error("questions file is empty");
  return out;
}

export function loadQuestions(file: string | URL): Questions {
  return validateQuestions(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Check a provider's parsed answers against the questions. Every question must be answered. */
export function validateAnswers(questions: Questions, answers: RawAnswers): RawAnswers {
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!answer) throw new Error(`missing answer: ${name}`);
    if (answer.type !== question.type) throw new Error(`missing answer: ${name}`);
    if (answer.type === "choice") {
      if (!Object.hasOwn((question as ChoiceQuestion).criteria, answer.choice)) throw new Error(`invalid answer: ${name}`);
    } else if (answer.type === "score") {
      if (!Number.isFinite(answer.score)) throw new Error(`invalid answer: ${name}`);
    } else if (!Number.isFinite(answer.yes) || answer.yes < 0 || answer.yes > 1) {
      throw new Error(`invalid answer: ${name}`);
    }
  }
  return answers;
}

/** Typed read access for policy code. Asking for a question that does not exist is a bug, so it throws. */
export class Answers {
  constructor(
    readonly raw: RawAnswers,
    private questions: Questions,
  ) {}

  private get<T extends Answer["type"]>(name: string, type: T): Extract<Answer, { type: T }> {
    const question = this.questions[name];
    if (!question) throw new Error(`policy asked for unknown question ${name}`);
    if (question.type !== type) throw new Error(`question ${name} is a ${question.type}, not a ${type}`);
    const answer = this.raw[name];
    if (!answer || answer.type !== type) throw new Error(`missing answer: ${name}`);
    return answer as Extract<Answer, { type: T }>;
  }

  /** The chosen category of a choice question. */
  choice(name: string): string {
    return this.get(name, "choice").choice;
  }

  /** The probability of each category, when the provider returns one. */
  probabilities(name: string): Record<string, number> {
    const question = this.questions[name];
    return question?.type === "score" ? this.get(name, "score").probabilities : this.get(name, "choice").probabilities;
  }

  /** The raw (possibly fractional) score. */
  score(name: string): number {
    return this.get(name, "score").score;
  }

  /** The score rounded to the nearest level and clamped to the question's range. */
  level(name: string): number {
    const levels = (this.questions[name] as ScoreQuestion).criteria.length;
    return Math.min(levels - 1, Math.max(0, Math.round(this.score(name))));
  }

  /** Probability of yes, 0..1. */
  yes(name: string): number {
    return this.get(name, "yesno").yes;
  }
}
