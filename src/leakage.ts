import type { AnyProject } from "./project.js";

/** Keys that name ground truth in any project. */
const ALWAYS_FORBIDDEN = ["expected", "facts", "ground_truth", "groundTruth"];

export class LeakageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeakageError";
  }
}

/**
 * Refuse an input that carries the answer. Checks every key at any depth against ground-truth names
 * and the decision's own field names, then scans everything except the customer's own words for
 * forbidden tokens. A customer who pastes "human_required" into a message has not leaked a label;
 * dropping their ticket for it would hide it from everyone.
 */
export function assertNoLeakage(project: AnyProject, input: Record<string, unknown>, decisionFields: string[]): void {
  const forbiddenKeys = new Set([...ALWAYS_FORBIDDEN, ...decisionFields, ...(project.leakage?.forbiddenKeys ?? [])]);
  const walk = (value: unknown, at: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) throw new LeakageError(`leaked key ${at}.${key}`);
        walk(child, `${at}.${key}`);
      }
    }
  };
  walk(input, "input");
  const freeText = new Set(project.leakage?.freeText ?? []);
  const built = Object.fromEntries(Object.entries(input).filter(([key]) => !freeText.has(key)));
  const blob = JSON.stringify(built);
  for (const token of project.leakage?.forbiddenTokens ?? []) {
    if (blob.includes(token)) throw new LeakageError(`leaked token ${token}`);
  }
}
