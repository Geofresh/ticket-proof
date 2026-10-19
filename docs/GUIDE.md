# Guide

A walkthrough from an empty folder to a sealed grade. The AcmeCloud example
(`examples/acmecloud/`) is the reference for every step.

## 1. Decide what the model is for

Write down the decisions you want to automate and which of them a mistake makes expensive. In the
example: who must see a ticket, whether it may be auto-answered, whether it is a takeover. Then
split each decision into **what the model is good at** (reading the message: is this a refund
request? is a symptom named?) and **what code is good at** (dates, amounts, account flags, "any
refund goes to a person"). The model answers questions; your policy decides.

A useful test: if you can state a rule without looking at a model output ("a refund always needs
a person"), it belongs in code. If it needs reading comprehension ("is the customer asking for
money back?"), it is a question.

## 2. Write the questions

`questions.json` maps a snake_case name to a question:

- `choice`: one category. `criteria` maps each category to a one-line meaning. Put the boundary
  cases in `instructions` ("a request for money back is billing").
- `score`: a level 0..n-1, one `criteria` line per level. Give each level a concrete anchor; levels
  that read alike get answered alike.
- `yesno`: a probability of yes. Ask one thing. Your policy picks the threshold.

Questions describe the world, not your workflow. Ask "is the customer reporting a charge they don't
recognize?", not "should this go to the fraud queue?". Then the answer survives a policy change.

Every word is part of the cache key. Rewording a question means every ticket is a new paid request,
so batch question edits, and measure them separately from policy edits.

## 3. Define the input

`input` is exactly what the model sees: the message plus whatever account context you would give
a new support agent. Keep it to fields you'd really have at triage time. List the field holding
the customer's own words under `leakage.freeText`, and put your workflow names and other internal
labels under `leakage.forbiddenTokens`. The guard refuses any input that carries `expected`,
`facts`, or one of your decision field names as a key.

## 4. Write the policy

```ts
function policy(a: Answers, input: Input): Decision
```

`a.choice("intent")`, `a.level("urgency")` (rounded, clamped), `a.score("urgency")` (raw),
`a.yes("security")` (0..1). Fix thresholds before you score anything, and write down why. The
example's are at the top of `project.ts`.

Order your overrides by which mistake you would rather make. In the example, any security signal
outranks billing, and a rule may add a person but the spam label alone never removes one.

Policy sees only the answers and the input. It can't read the ticket id, so it can't special-case a
test ticket.

Add `variants` for comparisons you will want again, such as `model-only` (the model's answers with
thresholds and nothing else). `--variant model-only` then shows what your code adds.

## 5. Write the dataset

```json
{ "id": "d_001", "input": { ... }, "facts": { ... }, "note": "why this ticket is here" }
```

Prefer `facts` plus an `expected(facts, ticket)` hook over hand-written `expected`. Facts are
statements about the ticket ("refund requested", "purchase 3 days ago", "account compromised");
the hook applies your written policy to them. Then a policy decision changes every label at once,
consistently, and nobody is tempted to fix one label because the model disagreed.

Mix in tickets you expect to be hard: the vague ones, the mixed ones ("cancel, and also checkout
is down"), the ones with instructions pasted inside the message. And realistic ordinary mail: the
lab's practice sets were written to contain vague edge cases, which made rules aimed at edge cases
look better than they were.

## 6. Weight the errors

`errors(expected, actual)` returns codes; `severity` gives each a weight. Without an `errors`
function you get `<field>_mismatch` for every field that differs. A custom one lets the same field
weigh differently by context: in the example, missing a person is 3, or 4 when the ticket was a
security case or urgency 3+. Every code needs a weight, or the ticket fails loudly.

`metrics` adds rates and counts that totals should show: recall on the cases that matter,
counts of the errors you never want. Give a metric `better: "higher"` or `"lower"` and the HTML
report colors its changes green or red; without it, changes stay neutral.

## 7. Practice, change, compare

```bash
pnpm practice my-project my-project/dev.json --label base
# change one rule in project.ts
pnpm practice my-project my-project/dev.json --label one-rule
pnpm compare base one-rule
pnpm report one-rule --vs base     # the same comparison as an HTML page in runs/report/
```

Read the worse tickets first (the Worse filter in the HTML report). A rule that fixes eight tickets
and breaks two is worth reading those two for. Since only code changed, the second run is free.

Practice reports (`runs/practice/*.json`) hold every ticket: its text, expected, actual, errors and
the model's rounded answers. Read them. That's what practice sets are for.

## 8. Before you trust a rule, try to break it

Write ordinary, realistic tickets aimed at the rule and see what it does to them. This is the step
that caught the bad rules in the lab this harness came from: see [LESSONS.md](LESSONS.md).

## 9. Seal and grade

Have a holdout written by someone (or some agent) that hasn't seen your policy code or your practice
sets, ideally from real-looking mail rather than from your policy text. Seal it before anyone reads
it, grade it once your change is final, and act on totals only.

`grade` prints field accuracy, your metrics, the severity counts and error-code counts. Failures are
counted by kind (`spend_cap`, `provider_http_429`, `answer:urgency`), never by ticket. It skips the
cache, so every grade is paid, and it logs how often each holdout has been graded. If you grade,
change and grade again, the holdout has become a practice set. Write a new one.

`practice` refuses:

- any file whose hash appears in a `SHA256` anywhere in the checkout, or that sits next to one;
- anything in a `sealed*` folder or named `holdout*`;
- symlinks to any of those.

Some rules the harness can't enforce:

- don't edit expected labels to match the model;
- don't drop or soften a hard ticket;
- don't special-case a ticket in policy or questions;
- don't move a threshold after seeing which ticket it missed.

## Models, cache and spend

| `HARNESS_PROVIDER` | Calls | Key |
| --- | --- | --- |
| `openrouter-decisions` (default) | OpenRouter's Decisions API (alpha), any model it serves | `OPENROUTER_API_KEY` |
| `openai-compatible` | `HARNESS_BASE_URL/chat/completions` with a JSON prompt built from your questions | `HARNESS_API_KEY`, or `OPENROUTER_API_KEY` for openrouter.ai |

```bash
# Another OpenRouter model
HARNESS_MODEL=<openrouter model id> pnpm practice ...

# A local OpenAI-compatible server
HARNESS_PROVIDER=openai-compatible HARNESS_BASE_URL=http://127.0.0.1:8000/v1 \
HARNESS_MODEL=<model> HARNESS_PRICE_IN_PER_M=0 HARNESS_PRICE_OUT_PER_M=0 pnpm practice ...
```

Set a project's usual provider and model in `defaults` to skip the variables. Keys come from the
environment or `.env` in the checkout, nowhere else. A chat model reports its own yes
probabilities, and they aren't calibrated the way a decisions API's are, so choose thresholds with
that in mind.

**Cache.** Answers are stored under a hash of provider, model, input and questions. Switching models
never serves another model's answers. A code-only change rescores for free. One changed word in a
question means a new request for every ticket. `--offline` turns a cache miss into an error instead
of a call.

**Spend.** Live calls go through a ledger (`runs/spend.json`) that stops before the next request once
`HARNESS_SPEND_CAP_USD` (default 5) is reached. Calls already in flight finish, so the cap can be
overshot by at most one call per worker. If the API reports no cost and you set no prices, each call
is booked at `HARNESS_FALLBACK_CALL_USD` (default $0.05), so no call counts as free by accident.

**Leakage guard.** Before any call, the input is checked at every depth for ground-truth keys
(`expected`, `facts`, your decision field names). Every field except the customer's own words is
scanned for the forbidden tokens you list, such as workflow names. A customer who pastes
`human_required=false` into a message hasn't leaked a label, so their ticket still runs.
