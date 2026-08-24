# Schema and naming

Define the schema in one module per service, export constants, and let nothing else invent a key. Ad-hoc strings at call sites are how one concept becomes `userId`, `user_id`, and `uid` in the same index.

## Required line fields

Emit these on every wide event. A missing one turns a triage query into a guess.

| Field | Example | Why it has to be there |
| --- | --- | --- |
| `ts` | `2026-08-24T10:11:44.443Z` | Ordering. RFC 3339, UTC, milliseconds. |
| `level` | `WARN` | Derived, never hardcoded. See `severity-errors.md`. |
| `name` | `OrderValidated` | The unit of work, in domain language. Also the grouping key. |
| `outcome` | `ok` \| `degraded` \| `error` \| `partial` | The one field every dashboard filters on. |
| `duration_ms` | `75` | Latency without subtracting timestamps by hand. |
| `service.name` | `payments-api` | Which service produced it. |
| `service.version` | `v2.14.3` | Correlating a regression with a deploy. |
| `deployment.environment` | `prod` | Keeps staging noise out of incident queries. |
| `trace_id`, `span_id` | `abc123...` | Jumping between the event and the trace. |
| `correlation_id` | `pay-7f3a91c4` | Stitching the flow when tracing is absent or sampled away. |
| `event_count`, `warn_count`, `error_count` | `26`, `1`, `0` | Counts at line level so "which flows finished carrying a warning" is a field filter, not JSON parsing in the query path. |
| `events` | `[ ... ]` | The narrative. Shape below. |

Add when applicable: `status_code`, `http.request.method`, `http.route`, `error.type`, `error.code`, `retriable`, `sample_rate`, `truncated`, `actor.id`, `tenant.id`, `region`, `host.name`, `deployment.id`.

## Entry shape

```json
{ "desc": "Performing antifraud evaluation.",
  "offset_ms": 10,
  "level": "info",
  "attrs": { "provider": "acme", "decision": "review" } }
```

`offset_ms` is measured from unit start, never as a delta from the previous entry. Offsets from one origin still make sense when a line is lost.

Anything constant for the whole unit belongs on the line, not inside `attrs`. Repeating `order_id` in 19 entries is the waste you just removed, one level down. In one published measurement that mistake accounted for roughly a third of the remaining payload.

## Naming rules

1. Keys are `snake_case`, values keep their natural casing.
2. Where OpenTelemetry semantic conventions already name a concept, use their name exactly: `http.request.method`, `server.address`, `messaging.destination.name`, `db.system.name`. Never invent `httpMethod` next to it.
3. Business fields get a domain namespace: `order.id`, `payment.provider`, `merchant.tier`. One namespace per aggregate, decided once.
4. Suffixes carry units and types: `_ms`, `_bytes`, `_cents`, `_count`, `_at` for timestamps, `is_`/`has_` for booleans. Money is an integer of minor units, never a float.
5. No key that encodes a value (`error_card_declined: true`). That is a value for `error.code`.

## High cardinality is the point

Ids, emails hashed, cart totals, feature flag combinations. These are what let you ask "all checkout failures for premium users in the last hour where the new flow was on, grouped by decline code". Wide and high-cardinality is the design goal, not an accident to be trimmed.

The one hard limit: never put an unbounded value in a field the backend indexes as a stream label or a metric dimension. That is where cardinality actually hurts. See `backends.md`.

## Controlling drift

Wide events accumulate fields over years the way handlers accumulate log lines. The failure mode is deferred, not avoided.

1. Version the schema with a `schema_version` integer on the line. Bump on any removal or type change.
2. Never change the type of an existing key. Add a new key.
3. Keep a single owner file per service and require review on it. Field additions are cheap; renames are not.
4. Contract-test the required fields so a refactor cannot quietly drop one. See `testing.md`.
