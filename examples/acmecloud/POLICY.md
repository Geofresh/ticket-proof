# AcmeCloud support policy (example)

AcmeCloud is fictional: a B2B SaaS with plans free ($0), starter ($29), pro ($99), business ($499)
and enterprise (custom). This is the policy `project.ts` implements, in words. It is trimmed from a
longer lab policy; the dataset authors wrote their tickets from the longer one, so a few expected
labels depend on rules this version leaves out. That is fine for a demo and one more reason its
numbers mean nothing.

## A person must see it

Security (a compromise signal in the message, an unseen-country login, an unexpected password
reset), urgency 3 or more, refunds, duplicate charges, any unrecognized charge, cancellations, a
charge over $500 when the ticket is about money, refund abuse (3 or more prior refunds), an API
status of outage, and a diagnosable ticket from a customer with 3 or more previous tickets.

## Refunds

Eligible when the purchase is at most 7 days old, the amount is at most $500, there is no refund
abuse, and it is not a security case. Eligibility is code. A person still confirms every refund.

## Not enough detail

A short message (under 12 words) that names no symptom, where nothing above applies, gets
`request_detail`: ask the customer what failed. It does not go to a person yet.

## Safe to automate

Only a how-to or feature request at urgency 0 or 1, with no security signal and no person
required, and only when the model's yes-probability is at least 0.98. The automated action is a
help article or a logged feature idea.

## Workflow

Chosen in code from the model's answers plus account facts. Security and production impact outrank
billing in a mixed message. Urgency 4 includes "the account may be compromised".
