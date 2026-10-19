/**
 * AcmeCloud: a fictional B2B SaaS support queue. A worked example, not a benchmark.
 *
 * The model answers the questions in questions.json. Everything below is code: thresholds, the
 * rules that force a person, the workflow choice, and the facts-to-expected labels. POLICY.md is
 * the same policy in plain words.
 */
import { defineProject, loadQuestions, type Answers } from "../../src/index.js";

// ---------------------------------------------------------------------------------------------
// What the model sees, and what the dataset author knows but the model never sees.

type Input = {
  company: "AcmeCloud";
  /** The customer's own words. */
  message: string;
  customer: { plan: "free" | "starter" | "pro" | "business" | "enterprise"; mrr: number; tenureDays: number; previousTickets: number };
  account: {
    billingStatus: "paid" | "past_due" | "none";
    apiStatus: "operational" | "degraded" | "outage";
    purchaseAgeDays: number | null;
    lastChargeUsd: number | null;
    priorRefundCount: number;
    unseenCountryLogin: boolean;
    unexpectedPasswordReset: boolean;
  };
};

type Level = 0 | 1 | 2 | 3 | 4;

/** Ground truth written by the dataset author. Never sent to the model. */
type Facts = {
  intent: string;
  urgency: Level;
  security: boolean;
  spam: boolean;
  engineering: boolean;
  productionBlocking: boolean;
  apiIssue: boolean;
  refundRequested: boolean;
  duplicateRenewal: boolean;
  priorRefundAbuse: boolean;
  unrecognizedCharges: number;
  destructiveAccountChange: boolean;
  incompleteContext: boolean;
  purchaseAgeDays: number | null;
  refundAmountUsd: number | null;
};

type Workflow =
  | "account_compromised"
  | "spam"
  | "production_api_failure"
  | "api_failure"
  | "billing_duplicate_charge"
  | "billing_refund"
  | "billing_question"
  | "subscription_cancel"
  | "account_login"
  | "bug_report"
  | "general_technical"
  | "feature_or_how_to"
  | "human_review"
  | "request_detail";

type Decision = {
  intent: string;
  urgency: number;
  workflow: Workflow;
  human_required: boolean;
  security: boolean;
  safe_to_automate: boolean;
  engineering_candidate: boolean;
  spam: boolean;
  refund_eligible: boolean;
};

// ---------------------------------------------------------------------------------------------
// Policy constants. Chosen before any ticket was scored, and not moved after seeing a miss.

const T = {
  human: 0.85,
  security: 0.65,
  safe: 0.98,
  engineering: 0.75,
  spam: 0.8,
  production: 0.7,
  api: 0.7,
  duplicate: 0.7,
  unrecognized: 0.7,
  refund: 0.7,
  detail: 0.5,
};
const REFUND_WINDOW_DAYS = 7;
const HIGH_VALUE_USD = 500;
const REFUND_ABUSE_COUNT = 3;
const REPEAT_TICKETS = 3;
const SHORT_MESSAGE_WORDS = 12;

/** Dataset authors used a few names for intents the questions already cover. */
const INTENT_ALIASES: Record<string, string> = {
  refund: "billing",
  product_question: "how_to",
  api_issue: "technical_issue",
  outage: "technical_issue",
  login_issue: "account_access",
};

type Signals = {
  intent: string;
  urgency: number;
  security: boolean;
  spam: boolean;
  production: boolean;
  api: boolean;
  duplicate: boolean;
  unrecognized: boolean;
  refund: boolean;
  engineering: boolean;
};

/** Security and production outrank billing in a mixed message. */
function workflowFrom(s: Signals): Workflow {
  if (s.security || s.intent === "security") return "account_compromised";
  if (s.spam) return "spam";
  if (s.production) return "production_api_failure";
  if (s.api && s.urgency < 3) return "api_failure";
  if (s.duplicate) return "billing_duplicate_charge";
  if (s.unrecognized) return "human_review";
  if (s.refund) return "billing_refund";
  if (s.intent === "billing") return "billing_question";
  if (s.intent === "subscription") return "subscription_cancel";
  if (s.intent === "account_change") return "human_review";
  if (s.intent === "account_access") return "account_login";
  if (s.intent === "technical_issue") return s.engineering ? "bug_report" : "general_technical";
  if (s.intent === "how_to" || s.intent === "feature_request") return "feature_or_how_to";
  return "human_review";
}

const MONEY_WORKFLOWS = new Set<Workflow>(["billing_refund", "billing_duplicate_charge", "subscription_cancel"]);

function accountHasEvidence(account: Input["account"]): boolean {
  return (
    account.unseenCountryLogin ||
    account.unexpectedPasswordReset ||
    account.apiStatus === "outage" ||
    account.priorRefundCount >= REFUND_ABUSE_COUNT
  );
}

/** The model's answers plus account facts, through rules a person could state without seeing a model output. */
function policy(a: Answers, input: Input): Decision {
  const { account, customer, message } = input;
  const intent = a.choice("intent");
  let urgency = a.level("urgency");
  const security = a.yes("security") >= T.security || account.unseenCountryLogin || account.unexpectedPasswordReset;
  // Urgency 4 includes "the account may be compromised", whatever the message is about.
  if (security) urgency = 4;
  const spam = !security && (a.yes("spam") >= T.spam || intent === "spam");
  const production = urgency >= 3 && (a.yes("production_impact") >= T.production || account.apiStatus === "outage");
  const api = a.yes("api_issue") >= T.api;
  const duplicate = a.yes("duplicate_charge") >= T.duplicate;
  const unrecognized = a.yes("unrecognized_charges") >= T.unrecognized;
  const refund = a.yes("refund_requested") >= T.refund;
  const engineeringSignal = a.yes("engineering_candidate") >= T.engineering;

  // The one hold rule: ask for detail only when nothing says a person must see it, the model
  // itself says no symptom is named, and the message is short. See docs/LESSONS.md before adding another.
  const mustSee = security || accountHasEvidence(account) || production || refund || duplicate || unrecognized;
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  const thin = !mustSee && !spam && intent !== "security" && a.yes("sufficient_detail") < T.detail && words < SHORT_MESSAGE_WORDS;

  const workflow: Workflow = thin
    ? "request_detail"
    : workflowFrom({ intent, urgency, security, spam, production, api, duplicate, unrecognized, refund, engineering: engineeringSignal });

  const moneyTicket = refund || duplicate || unrecognized || intent === "billing" || intent === "subscription" || MONEY_WORKFLOWS.has(workflow);
  const forceHuman =
    security ||
    account.priorRefundCount >= REFUND_ABUSE_COUNT ||
    (moneyTicket && (account.lastChargeUsd ?? 0) > HIGH_VALUE_USD) ||
    unrecognized ||
    account.apiStatus === "outage" ||
    urgency >= 3 ||
    MONEY_WORKFLOWS.has(workflow) ||
    customer.previousTickets >= REPEAT_TICKETS ||
    workflow === "account_compromised" ||
    workflow === "production_api_failure" ||
    workflow === "human_review";
  let human = !thin && (forceHuman || a.yes("human_required") >= T.human);
  // The spam label alone never removes a person from a ticket that also carries money or evidence.
  if (workflow === "spam" && (refund || duplicate || unrecognized || accountHasEvidence(account))) human = true;

  const safe = !human && !security && urgency <= 1 && workflow === "feature_or_how_to" && a.yes("safe_to_automate") >= T.safe;
  // A ticket that still has to say what failed is not an engineering candidate yet.
  const engineering = workflow !== "request_detail" && (engineeringSignal || account.apiStatus === "outage");
  const refundEligible =
    workflow === "billing_refund" &&
    account.purchaseAgeDays != null &&
    account.purchaseAgeDays <= REFUND_WINDOW_DAYS &&
    (account.lastChargeUsd ?? 0) <= HIGH_VALUE_USD &&
    account.priorRefundCount < REFUND_ABUSE_COUNT &&
    !security;

  return {
    intent: spam ? "spam" : intent,
    urgency,
    workflow,
    human_required: human,
    security,
    safe_to_automate: safe,
    engineering_candidate: engineering,
    spam,
    refund_eligible: refundEligible,
  };
}

/** The model's answers alone: the same thresholds, no account facts, no forced-human rules, no hold. */
function modelOnly(a: Answers): Decision {
  const intent = a.choice("intent");
  const urgency = a.level("urgency");
  const security = a.yes("security") >= T.security;
  const spam = !security && (a.yes("spam") >= T.spam || intent === "spam");
  const engineering = a.yes("engineering_candidate") >= T.engineering;
  const workflow = workflowFrom({
    intent,
    urgency,
    security,
    spam,
    production: urgency >= 3 && a.yes("production_impact") >= T.production,
    api: a.yes("api_issue") >= T.api,
    duplicate: a.yes("duplicate_charge") >= T.duplicate,
    unrecognized: a.yes("unrecognized_charges") >= T.unrecognized,
    refund: a.yes("refund_requested") >= T.refund,
    engineering,
  });
  const human = a.yes("human_required") >= T.human;
  return {
    intent: spam ? "spam" : intent,
    urgency,
    workflow,
    human_required: human,
    security,
    safe_to_automate: !human && a.yes("safe_to_automate") >= T.safe,
    engineering_candidate: engineering,
    spam,
    // The model is not asked about refund eligibility; only code can check the dates and amounts.
    refund_eligible: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Facts to expected decision. This is the policy applied to what the author knows, so the labels
// are never edited to match the model.

function workflowFromFacts(f: Facts, intent: string, thin: boolean): Workflow {
  if (f.security) return "account_compromised";
  if (f.spam) return "spam";
  if (f.productionBlocking) return "production_api_failure";
  if (f.apiIssue) return "api_failure";
  if (f.duplicateRenewal) return "billing_duplicate_charge";
  if (f.unrecognizedCharges >= 1) return "human_review";
  if (f.refundRequested) return "billing_refund";
  if (intent === "subscription") return "subscription_cancel";
  if ((intent === "account_change" || f.destructiveAccountChange) && thin) return "request_detail";
  if (intent === "account_change" || f.destructiveAccountChange) return "human_review";
  if (intent === "account_access") return "account_login";
  if (thin) return "request_detail";
  if (intent === "technical_issue") return f.engineering ? "bug_report" : "general_technical";
  if (intent === "billing") return "billing_question";
  if (intent === "how_to" || intent === "feature_request") return "feature_or_how_to";
  return "human_review";
}

function expected(f: Facts, ticket: { input: Input }): Decision {
  const intent = INTENT_ALIASES[f.intent] ?? f.intent;
  const thin = f.incompleteContext && !f.security && !f.productionBlocking && !f.spam;
  const human =
    !thin &&
    (f.security ||
      f.urgency >= 3 ||
      f.priorRefundAbuse ||
      (f.refundAmountUsd ?? 0) > HIGH_VALUE_USD ||
      f.unrecognizedCharges >= 1 ||
      f.destructiveAccountChange ||
      f.refundRequested ||
      f.duplicateRenewal ||
      (intent === "subscription" && !f.spam) ||
      ticket.input.customer.previousTickets >= REPEAT_TICKETS);
  return {
    intent,
    urgency: f.urgency,
    workflow: workflowFromFacts(f, intent, thin),
    human_required: human,
    security: f.security,
    safe_to_automate:
      !human && !f.security && !f.spam && f.urgency <= 1 && (intent === "how_to" || intent === "feature_request"),
    engineering_candidate: f.engineering,
    spam: f.spam,
    refund_eligible:
      f.refundRequested &&
      (f.purchaseAgeDays ?? 999) <= REFUND_WINDOW_DAYS &&
      (f.refundAmountUsd ?? 0) <= HIGH_VALUE_USD &&
      !f.priorRefundAbuse &&
      !f.security,
  };
}

// ---------------------------------------------------------------------------------------------
// Errors and their weights. A ticket's severity is its worst error: 4 is the kind of mistake that
// hurts a customer (a missed takeover, an automated refund), 0 is cosmetic.

const COSMETIC_INTENTS = new Set(["how_to", "feature_request"]);

function errors(e: Decision, a: Decision): string[] {
  const out: string[] = [];
  if (e.intent !== a.intent) out.push(COSMETIC_INTENTS.has(e.intent) && COSMETIC_INTENTS.has(a.intent) ? "intent_near_miss" : "intent_mismatch");
  const delta = Math.abs(e.urgency - a.urgency);
  if (e.urgency >= 3 && a.urgency <= 1) out.push("urgency_downgrade_severe");
  else if (e.urgency >= 3 && a.urgency === 2) out.push("urgency_downgrade");
  else if (delta === 2) out.push("urgency_off_by_2");
  else if (delta === 1) out.push("urgency_off_by_1");
  else if (delta > 2) out.push("urgency_off_by_2");
  if (e.security && !a.security) out.push("missed_security");
  else if (!e.security && a.security) out.push("false_security");
  if (e.workflow === "request_detail" && a.human_required) out.push("vague_reached_human");
  if (e.human_required && !a.human_required) out.push(e.security || e.urgency >= 3 ? "missed_human_critical" : "missed_human");
  else if (!e.human_required && a.human_required) out.push("unnecessary_human");
  if (!e.safe_to_automate && a.safe_to_automate) out.push("false_safe");
  else if (e.safe_to_automate && !a.safe_to_automate) out.push("over_conservative_safe");
  if (e.engineering_candidate && !a.engineering_candidate) out.push(e.urgency >= 3 ? "missed_engineering_urgent" : "missed_engineering");
  else if (!e.engineering_candidate && a.engineering_candidate) out.push("unnecessary_engineering");
  if (e.spam !== a.spam) out.push("spam_mismatch");
  if (e.workflow !== a.workflow) out.push("wrong_workflow");
  if (e.refund_eligible !== a.refund_eligible) out.push("refund_eligibility_wrong");
  return out;
}

export default defineProject<Input, Facts, Decision>({
  name: "acmecloud",
  questions: loadQuestions(new URL("questions.json", import.meta.url)),
  policy,
  variants: { "model-only": modelOnly },
  expected,
  errors,
  severity: {
    intent_near_miss: 0,
    intent_mismatch: 1,
    urgency_off_by_1: 1,
    urgency_off_by_2: 2,
    urgency_downgrade: 3,
    urgency_downgrade_severe: 4,
    missed_security: 4,
    false_security: 2,
    vague_reached_human: 3,
    missed_human_critical: 4,
    missed_human: 3,
    unnecessary_human: 2,
    false_safe: 4,
    over_conservative_safe: 1,
    missed_engineering_urgent: 3,
    missed_engineering: 2,
    unnecessary_engineering: 1,
    spam_mismatch: 1,
    wrong_workflow: 2,
    refund_eligibility_wrong: 2,
  },
  fields: ["intent", "urgency", "workflow", "human_required", "security", "safe_to_automate", "engineering_candidate", "refund_eligible"],
  metrics: {
    securityRecall: { where: (e) => e.security, hit: (_e, a) => a.security, better: "higher" },
    criticalHumanRecall: { where: (e) => e.human_required && (e.security || e.urgency >= 3), hit: (_e, a) => a.human_required, better: "higher" },
    falseSafe: { hit: (e, a) => !e.safe_to_automate && a.safe_to_automate, count: true, better: "lower" },
    vagueReachedHuman: { hit: (e, a) => e.workflow === "request_detail" && a.human_required, count: true, better: "lower" },
  },
  leakage: {
    freeText: ["message"],
    forbiddenTokens: ["account_compromised", "production_api_failure", "billing_duplicate_charge", "billing_refund", "request_detail"],
  },
  preview: (input) => input.message.replace(/\s+/g, " ").slice(0, 120),
  defaults: { provider: "openrouter-decisions", model: "~typesafe/jev-latest" },
  cacheDir: "cache",
});
