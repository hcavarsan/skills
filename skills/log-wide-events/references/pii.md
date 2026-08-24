# Sensitive data

Wide events make this sharper than line logging did, because the whole context of a request now sits in one place. That is the value, and it is also the risk: one bad field is now one bad field on every request.

Enforce in the emitter. Reviewer memory is not a control.

## Never emit, in any form

1. Full payment card numbers, CVV, track data. PCI DSS makes this a finding, not a style preference.
2. Passwords, tokens, API keys, `Authorization` and `Cookie` headers, session ids, signed URLs with credentials.
3. Full request or response bodies. It feels helpful for two weeks and then it is a breach waiting for a subpoena.
4. Health data, government ids, biometrics, precise location, anything a DPA lists as special category.
5. Free-text user input (support messages, addresses typed by a human). Unbounded and almost always personal.

## Emit safely instead

| Instead of | Emit |
| --- | --- |
| card number | `card.bin` (first 6), `card.last4`, `card.brand` |
| email | `user.id`, plus `email.domain` if you need it, or a keyed HMAC |
| full name | `user.id` |
| request body | field-level projections you query (`item_count`, `total_cents`, `currency`) |
| auth header | `auth.method`, `auth.scope_count`, `token.expires_at` |

Hash with a keyed HMAC and a rotating key, not a bare SHA-256, when you need joinability without identity. A bare hash of an email is reversible by dictionary in seconds.

## Two controls in the emitter

1. **Deny list, enforced at write time.** Reject or redact keys matching `password|secret|token|authorization|cookie|card_number|pan|cvv|ssn|cpf`, and values matching a card-number or JWT shape. Emit `redacted_count` on the line so you can see when it fires, because a firing redaction usually means someone tried to add a field they should not.
2. **Allow list at the schema layer.** The schema module in `schema.md` is the list of legal fields. A key nobody declared does not reach the backend. This is stricter and it is what regulated systems need.

Belt and braces: keep a `transform`/`filter` redaction stage in the collector too, but treat it as a safety net. A rule in the collector that never fires is a healthy system; a rule that is your only defense is a leak waiting for a config error.

## Retention and access

- The audit-relevant events (state changes, decisions, money moving) usually need longer retention than debug narrative. Route them to a separate stream or table with its own TTL rather than keeping everything for seven years.
- Whoever can query wide events can see production business data. Set access accordingly and log the access. In regulated environments, "everyone in engineering has Datadog" plus "wide events carry customer context" is a finding.
- Right-to-erasure requests reach your logs. Keying personal data behind a `user.id` that you can delete or re-key is what makes those requests answerable at all.
