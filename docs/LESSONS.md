# Lessons

One lesson from the lab this harness was cut down from. It is a lesson, not a result: no number on
this page is evidence about any model or any real support queue.

## The setup

An LLM answered fixed questions about tickets for a fictional SaaS; code owned the policy. Practice
and holdout sets were written by other LLM agents, each given the written policy and the input
schema, not the classifier. One policy line was "if the message names no symptom, ask the customer
for detail; do not send it to a person yet."

## What happened

Over one day, rules were added that **held a ticket for detail** or **dropped it as spam** using
message patterns: wider "generic failure" phrases ("is wrong", "acting up", "unreliable", "fails",
the same claims in other languages), a content-free chaser rule ("is anyone there", "following
up"), an unnamed-target rule ("remove the user who left", "delete my data"), wider phishing
patterns, a spam drop with no person, and a cap on the urgency of held tickets.

Each one improved the practice sets. They had to: the sets were written from a policy that says
vague tickets get held, so they were full of vague tickets for these rules to catch.

Then five independent reviews probed the code with realistic mail and kept finding ordinary
tickets that lost their person:

- "Login fails for everyone since this morning"
- "please remove our user Sam, he was fired today"
- "share your customer data processing agreement"
- "Following up: API 500 errors"

On probes aimed at those detectors, 30 of 36 lost a person compared with the code before that day.
A later attempt, a hold only when the model and every detector agreed a failure ticket named
nothing, lost a person on 34 of 108 review probes. All of it was reverted. The cost of reverting:
some genuinely content-free tickets ("billing is wrong") and some phishing spam reach a person
again. That is the error in the safe direction.

## The rule of thumb that came out of it

A message pattern may **add** a person, **rescue** a ticket from a hold, or **block** automation.
It should not hold a ticket or drop one unless a review with realistic mail has tried to break it.

The asymmetry is the cost: a needless escalation costs a minute of someone's time; a held outage or
a dropped "he was fired today, remove him" costs much more, and nobody sees it happen.

## Why the practice sets lied

**LLM-written test sets graded against your own policy are circular.** The author model read the
policy and wrote tickets that illustrate it. The labels are the policy applied to those tickets.
A rule written from the same policy text will fit them, whether or not it fits mail written by
people who have never read your policy. High scores on such a set measure agreement between two
readings of one document.

This applies to the demo in this repo: its 50 tickets and their labels came from the same policy
the example code implements. Use sets like that for what they are good at: catching crashes,
showing what a change moved, and finding tickets worth reading.

What helped:

- Probe sets aimed at the failure you fear ("150 plainly named problems that must not be held",
  "150 tickets policy sends to a person"), run before and after a rule.
- Reviews that try to break a rule with ordinary mail, not edge cases.
- Holdouts sealed before the change and graded once, on totals.
- Comparing ticket by ticket (`pnpm compare`) and reading every WORSE line, not just the totals.
