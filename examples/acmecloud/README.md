# AcmeCloud example

A demo for a fictional SaaS. An LLM wrote these tickets from the same policy that grades them, so a
high score only shows that one LLM agrees with the text another LLM was given
([why that matters](../../docs/LESSONS.md)).

| File | What it is |
| --- | --- |
| `project.ts` | Questions, policy, a model-only variant, facts-to-expected, error weights, metrics |
| `POLICY.md` | The same policy in words |
| `questions.json` | What the model is asked: one choice, two scores, eleven yes/no questions (the policy ignores `frustration`; it stays so the cached answers still match) |
| `tickets.json` | 50 practice tickets with facts (38 ordinary, 12 with steering attempts in the message) |
| `cache/` | One stored model answer per ticket, so the demo runs with no key |

```bash
pnpm demo                                                            # both runs plus a compare
pnpm practice examples/acmecloud examples/acmecloud/tickets.json --offline
pnpm practice examples/acmecloud examples/acmecloud/tickets.json --offline --variant model-only
```

The cached answers came from OpenRouter's `~typesafe/jev-latest` (served as
`typesafe/jev-1.14-20261014`) in October 2026, through the Decisions API, with exactly these
questions and inputs. Change one word of `questions.json` and every ticket misses the cache:
`--offline` then fails instead of calling anything. Change only `project.ts` and every ticket
rescores for free.

The harness doesn't depend on that model. Set `HARNESS_PROVIDER` and `HARNESS_MODEL` to run any
OpenRouter model or OpenAI-compatible server ([guide](../../docs/GUIDE.md#models-cache-and-spend)).
Another model misses this cache and makes real calls.

Ticket ids keep their origin: `dev_`, `d2_`, `d3_`, `d4_` come from four practice sets written by
separate LLM agents from the policy alone; `adv_` tickets carry injected instructions, fake routing
JSON or staff impersonation inside the message. Names, emails and companies in them are invented.
