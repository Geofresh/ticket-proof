# ticket-proof

Find out which support-ticket decisions you can hand to an LLM, using your own policy and your own
tickets.

The model only answers questions about a ticket: what it's about, how urgent it is, whether it
mentions a compromised account. Your code makes the decisions: who has to see it, which queue it
goes to, whether it can be answered automatically. ticket-proof scores those decisions against
labeled tickets, weights each mistake by how much it would hurt, and shows which tickets a change
fixed and which it broke.

## Why

I built this while testing whether a cheap model could triage tickets for a made-up SaaS. Rules that
looked like clear wins on LLM-written test tickets kept failing on ordinary mail. "Login fails for
everyone since this morning" got a "please send more detail" reply instead of a person.
[docs/LESSONS.md](docs/LESSONS.md) has the details.

The harness is the reusable part of that work:

- Model answers are cached, so changing the policy costs nothing to rescore.
- Severity weights let one missed security report outrank a dozen wrong queues.
- Sealed holdouts stop you from quietly tuning to your test set.

## Try it

Needs Node 20+ and pnpm 9 (`corepack enable`).

```bash
git clone https://github.com/Geofresh/ticket-proof.git
cd ticket-proof
pnpm install
pnpm demo
```

The demo needs no API key. It scores 50 example tickets from cached answers twice: once on the
model's answers alone, once through the example policy. It prints what changed and writes
`runs/report/demo.html`:

![HTML report for the demo comparison](docs/report.png)

An LLM wrote the example tickets from the same policy that grades them, so the numbers only show how
the tool works.

## Your own project

A project is one `project.ts` ([full example](examples/acmecloud/project.ts)):

```ts
import { defineProject, loadQuestions } from "../../src/index.js";

export default defineProject<Input, Facts, Decision>({
  name: "my-queue",
  questions: loadQuestions(new URL("questions.json", import.meta.url)),
  policy: (answers, input) => ({
    human_required: answers.yes("needs_person") >= 0.85 || input.account.flagged,
    queue: answers.choice("topic"),
  }),
  expected: (facts) => ({ human_required: facts.risky, queue: facts.topic }),
  severity: { human_required_mismatch: 4, queue_mismatch: 1 },
});
```

Questions are a choice, a 0..n score, or a yes/no probability:

```json
{
  "topic": { "type": "choice", "instructions": "Which queue?", "criteria": { "billing": "Money.", "technical": "Something fails." } },
  "urgency": { "type": "score", "instructions": "How urgent?", "criteria": ["Routine.", "Minor.", "Blocked.", "Down."] },
  "needs_person": { "type": "yesno", "instructions": "Does a person need to see this first?" }
}
```

Tickets carry `input`, which the model sees, and `facts`, which it never sees. Expected decisions
come from the facts through your `expected` hook, so no label is ever copied from a model answer.

```json
[{ "id": "t1", "input": { "message": "I was charged twice", "account": { "flagged": false } },
   "facts": { "topic": "billing", "risky": true } }]
```

Then change one rule at a time and compare:

```bash
pnpm practice my-project my-project/dev.json --label base
# edit a rule in project.ts
pnpm practice my-project my-project/dev.json --label new-rule
pnpm report new-rule --vs base
```

Only code changed, so the second run is served from cache. [docs/GUIDE.md](docs/GUIDE.md) walks
through each piece.

## Commands

| Command | Does |
| --- | --- |
| `pnpm practice <project> <tickets.json...> [--label L] [--variant V] [--offline]` | Score tickets, save every result to `runs/practice/` |
| `pnpm compare <before> <after>` | Print what changed between two runs, worst first |
| `pnpm report <run> [--vs <baseline>]` | Same, as an HTML page in `runs/report/` |
| `pnpm seal <holdout.json>` | Hash an unread holdout and make it read-only |
| `pnpm grade <project> <holdout.json>` | Score a sealed holdout live, totals only |
| `pnpm demo` | The example, from cache |

## Models

The default provider is OpenRouter's Decisions API, which handles choice, score and yes/no
questions natively. Pick the model with `HARNESS_MODEL`. Any OpenAI-compatible endpoint works too,
local servers included. Copy `.env.example` to `.env` and fill in a key.

Live calls stop at a spend cap, $5 unless you set `HARNESS_SPEND_CAP_USD`. Cache, pricing and the
check that keeps labels out of the model's input are covered in the [guide](docs/GUIDE.md#models-cache-and-spend).

## Keeping the test honest

Practice sets stop being evidence once you've written rules while reading them. For a number you
can trust:

1. Have someone who hasn't seen your policy code write a holdout. Don't read it.
2. `pnpm seal` it. `practice` will then refuse to run on it.
3. Finish the change, then `pnpm grade` once. You get totals, never individual tickets.
4. If you change things and want to grade again, write a new holdout.

One problem this can't fix: if an LLM wrote your test tickets from your own policy, grading the
policy on them is circular. Real tickets labeled by people are the only real fix.

## Credits

Built with [Claude Code](https://claude.com/claude-code).

## License

MIT
