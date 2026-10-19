import { describe, expect, it } from "vitest";
import { Answers, validateAnswers, validateQuestions } from "../src/questions.js";
import { answers, QUESTIONS } from "./helpers.js";

describe("questions", () => {
  it("accepts choice, score and yesno questions", () => {
    expect(Object.keys(validateQuestions(QUESTIONS))).toEqual(["topic", "urgency", "needs_person"]);
  });

  it("rejects malformed questions", () => {
    expect(() => validateQuestions({ Bad: { type: "yesno", instructions: "x" } })).toThrow(/snake_case/);
    expect(() => validateQuestions({ a: { type: "choice", instructions: "x", criteria: { one: "1" } } })).toThrow(/two criteria/);
    expect(() => validateQuestions({ a: { type: "score", instructions: "x", criteria: [] } })).toThrow(/criteria line/);
    expect(() => validateQuestions({ a: { type: "maybe", instructions: "x" } })).toThrow(/type must be/);
    expect(() => validateQuestions({ a: { type: "yesno", instructions: "" } })).toThrow(/instructions/);
  });

  it("rejects answers that are missing, the wrong type, or off the list", () => {
    expect(() => validateAnswers(QUESTIONS, { ...answers("billing", 0.5), needs_person: undefined as never })).toThrow("missing answer: needs_person");
    expect(() => validateAnswers(QUESTIONS, answers("refund", 0.5))).toThrow("invalid answer: topic");
    expect(() => validateAnswers(QUESTIONS, answers("billing", 1.5))).toThrow("invalid answer: needs_person");
    expect(() => validateAnswers(QUESTIONS, answers("billing", Number.NaN))).toThrow("invalid answer: needs_person");
  });

  it("gives policy typed access and refuses unknown or mistyped questions", () => {
    const a = new Answers(answers("billing", 0.7, 2.6), QUESTIONS);
    expect(a.choice("topic")).toBe("billing");
    expect(a.yes("needs_person")).toBe(0.7);
    expect(a.score("urgency")).toBe(2.6);
    expect(a.level("urgency")).toBe(2);
    expect(new Answers(answers("billing", 0.7, 9), QUESTIONS).level("urgency")).toBe(2);
    expect(() => a.yes("topic")).toThrow(/is a choice/);
    expect(() => a.yes("nope")).toThrow(/unknown question/);
  });
});
