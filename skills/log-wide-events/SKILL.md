---
name: log-wide-events
description: Instrument any app with wide events (canonical log lines) instead of line-by-line logging, in Go, Python, Java, TypeScript, Rust, or .NET. Use this skill whenever the task touches logging or observability code at all: adding a logger call, reviewing a PR that adds one, designing telemetry for a new service, refactoring a handler full of log.info calls, cutting log volume or ingestion cost, choosing what fields an event carries, wiring correlation ids across services, setting up tail sampling, or mapping events onto OpenTelemetry spans and log records. Trigger even when the user never says "wide events": phrases like "add logging here", "improve observability", "our logs are useless", "we log too much", "reduce the Datadog/Loki/Splunk bill", "why did this request fail in prod", "add tracing", or a pasted handler with scattered print/log statements all mean this skill applies. Also use it to decide when wide events are the wrong answer (long-running jobs, streaming, low-cardinality backends).
---

# Wide events

Start here: name the unit of work in the language of the business, then write one emitter that fires exactly once in a `finally`. Everything below is detail on that sentence.

## Step 0: gate, 30 seconds, do not skip

Wide events are wrong for some workloads. Check before writing any code.

1. The unit of work starts and ends within minutes. A 6 hour batch job or an open WebSocket has no end to emit at. Read `references/workloads.md` first.
2. The backend can filter and group on fields with millions of distinct values. If it only indexes a handful of stream labels and brute-forces the rest, read `references/backends.md` first. On a managed platform, the emit path is `stdout` and the platform's parser decides what stays queryable: read `references/gcp-cloud-logging.md` or `references/aws-cloudwatch.md` before choosing field names.
3. The service emits more than about 5 lines per request today. If it already emits one good line, there is nothing to fix. Stop.
4. The real question is not intra-step causality. A wide event tells you the persistence stage took 22 ms. It does not tell you which branch the handler took. Keep spans or debug logs for that.

Gates 1 to 3 pass: continue. Gate 4 fails: instrument spans instead, and say so.

Time cost, so the reader can plan: emitter plus first instrumented unit is 2 to 4 hours in a codebase that already has request-scoped context. A day if you have to introduce that context. Full service migration is a week of calendar time because it ships behind a flag and runs in parallel.

## The doctrine

### Five rules that make telemetry correct

1. **One event per unit of work per service.** Not per step, not per function, not per layer. Steps become entries inside the event.
2. **Emit in `finally`.** The unit that crashed is the one you most need. An emitter on the happy path only is a lie by omission.
3. **Line severity is the maximum severity carried inside.** One warn entry makes the line `WARN`. One error makes it `ERROR`. Every existing severity alert keeps working, and you avoid the failure where errors become entries in an `INFO` blob and your error rate drops to zero because errors went invisible.
4. **Errors get an immediate line of their own, in addition to being recorded in the event.** Stack traces belong on their own line, and an exception can prevent the emit from happening. The duplication is deliberate and cheap because errors are rare.
5. **Never sample out errors, slow units, or flagged actors.** Sample the boring successes, record the `sample_rate` you used, and multiply by it when aggregating. Details in `references/sampling.md`.

### Five rules that keep it from rotting

6. **Attributes constant for the whole unit go on the line, not repeated in every entry.** Repeating `order_id` 19 times inside one event is the same waste you just deleted, one nesting level down.
7. **Offsets are measured from unit start, never as deltas between steps.** Offsets from a single origin survive a dropped line. Deltas do not.
8. **Field names come from one schema module.** No string literals at call sites. This is the only defense against the same concept arriving as `userId`, `user_id`, and `uid`.
9. **No unstructured message strings carrying data.** `"charged user 123 for 4599"` is unqueryable. Data goes in fields, always.
10. **Nothing secret or personal in raw form.** Card numbers, tokens, auth headers, full emails. Enforce with a deny list in the emitter, not with reviewer memory. See `references/pii.md`.

## Instrument a new unit of work

1. Name the unit in domain language: `OrderValidated`, `InvoiceIssued`, `WebhookDelivered`. If you cannot name it without referring to code, the boundary is wrong. `Checkpoint2` and `AfterServiceCall` mean nothing to the person reading at 3 a.m.
2. Create the accumulator at the entry point (HTTP middleware, consumer wrapper, job runner) and hang it on request-scoped context. Go: `context.Context`. Python: `contextvars`. Java: pass it explicitly, or `ScopedValue` on JDK 25+. Never a thread-local or a global, and never MDC as the store, because both break across thread pools, async hops, and reactive chains. Language details in `references/go.md`, `references/python.md`, `references/java.md`, `references/typescript.md`, `references/other-runtimes.md`.
3. Set the line-level fields the middleware already knows: identity of the service and build, trace and correlation ids, transport fields, actor and tenant. Full canonical shape in `references/schema.md`.
4. In the handler, replace each `log.info(...)` with `unit.Add(description, attrs)` and each `unit.Set(key, value)` for anything constant across the unit. The handler adds business meaning only. It never emits.
5. Emit once in `finally`, with `outcome`, `duration_ms`, `event_count`, `warn_count`, `error_count`, and the entries array. Severity from rule 3.
6. Verify with the checks in "Before you call it done" below.

Default to one event. Split into stages only when `references/checkpoints.md` says your domain earns it.

## Refactor an existing service

Order matters here, because the usual failure is pruning first and losing information you cannot get back.

1. **Measure the baseline.** Lines per unit of work, bytes per unit, bytes scanned by the query you actually run during incidents. Without this you get an opinion instead of a result.
2. **Change the shape, keep the words.** Pass existing message strings through verbatim into the entry description. Every dashboard, alert, and saved query that matches on message text keeps working, which is what makes this shippable incrementally instead of as a coordinated switchover.
3. **Ship behind a flag, run both paths for a week, compare.**
4. **Prune second.** Now that all 47 entries sit in one payload, the useless ones are visibly useless. The test that holds up: if this entry were missing from the story, would I notice, and would I be worse off?
5. **Remove the old lines and the flag.** Full playbook, including what to expect from the numbers, in `references/refactor.md`.

One published measurement, for calibration and not as a promise: 48 lines collapsed to 3, total bytes down 76.6%, bytes scanned by the incident query down 89%, business events preserved 48 to 47. Bytes per line went **up** 77%, which is the mechanism working, not a regression.

## What earns an entry

Keep:

1. Decision points, anywhere the flow could have gone another way.
2. Boundaries: another service, the database, the cache, the queue. This is where time and failures come from.
3. State changes with audit value, the things a dispute or a regulator asks about later.
4. Values that changed: the resolved merchant id, the replaced processing code. Record the result, not the intention.

Drop:

1. Paired intention and completion lines. `Building request` then `Request built` is one entry, unless you would ever measure the gap.
2. Method entry and exit. `Receiving payment message` tells you the handler you are already reading is running.
3. Restatements. `Account found` right after `Retrieving account`.
4. Anything that was a debug note the author left for themselves and has been billed monthly ever since.

## Before you call it done

Run these, do not reason about them:

1. Exercise the happy path. Confirm exactly one line per unit, and that it carries every field in the required table of `references/schema.md`.
2. Force a failure mid-unit. Confirm the line still appears, `outcome` is `error`, severity is `ERROR`, and a separate immediate line carries the stack trace.
3. Force a warn-only path. Confirm severity is `WARN` and `warn_count` is 1, so severity-based alerts still fire.
4. Grep the changed files for the old logger call and for raw string interpolation. Both should be gone from handler code.
5. Run the incident query against the new shape and check it answers the question in one query, with no client-side JSON parsing. Patterns in `references/queries.md`.

## Reference files

Read the one that matches the task, not all of them.

| Read | When |
| --- | --- |
| `references/schema.md` | Choosing field names, required line fields, entry shape, schema versioning |
| `references/checkpoints.md` | Deciding between one event and several stages for a flow |
| `references/severity-errors.md` | Severity promotion, immediate error lines, partial emits, outcome values |
| `references/go.md` | Go, `log/slog`, `context.Context`, net/http or gRPC middleware |
| `references/python.md` | Python, `contextvars`, ASGI/WSGI, Celery, structlog or stdlib json |
| `references/java.md` | Java or Kotlin, Spring, `ScopedValue`, MDC bridging, Logback JSON |
| `references/typescript.md` | Node or Bun, `AsyncLocalStorage`, pino, Express/Fastify/Hono |
| `references/other-runtimes.md` | Rust, .NET, Ruby, Elixir, PHP |
| `references/workloads.md` | Consumers, batch, streaming, cron, CLI, serverless, gateways |
| `references/refactor.md` | Migrating a legacy logging codebase, measuring the baseline |
| `references/sampling.md` | Volume or cost pressure, tail sampling, unbiased aggregates |
| `references/otel.md` | OpenTelemetry, spans versus log records, semantic conventions |
| `references/backends.md` | ClickHouse, Loki, BigQuery, Datadog, Splunk, Elastic |
| `references/gcp-cloud-logging.md` | Cloud Run, GKE, Cloud Functions, stdout to Cloud Logging, severity enum, Error Reporting, log-based metrics |
| `references/aws-cloudwatch.md` | Lambda, ECS, EKS, stdout to CloudWatch Logs, Logs Insights, EMF metrics |
| `references/queries.md` | Day 2 triage, alerting, SLOs, dashboards from events |
| `references/pii.md` | Payments, health, or personal data in the payload |
| `references/testing.md` | Tests that keep instrumentation from silently breaking |
| `references/review-checklist.md` | Reviewing someone else's logging PR |

## Sources

- Luiz Dubiela, [Wide Events: cutting 80% of log volume and improving observability](https://lfdubiela.github.io/wide-events/) (2026). The accumulator, checkpoints, severity promotion, and the measured numbers.
- Boris Tane, [Logging sucks](https://loggingsucks.com/) (2024). Cardinality, dimensionality, tail sampling, why OpenTelemetry alone does not fix the mental model.
- Brandur Leach, [Canonical Log Lines](https://brandur.org/canonical-log-lines) (2016), and Stripe, [Fast and flexible observability with canonical log lines](https://stripe.com/blog/canonical-log-lines) (2019).
- Jeremy Morrell, [A Practitioner's Guide to Wide Events](https://jeremymorrell.dev/blog/a-practitioners-guide-to-wide-events/) (2024).
- Abraham et al., [Scuba: Diving into Data at Facebook](https://vldb.org/pvldb/vol6/p1057-wiener.pdf) (2013).
