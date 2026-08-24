# OpenTelemetry

OpenTelemetry is a protocol and a set of SDKs. It standardizes how telemetry is collected and exported, which is genuinely useful. It does not decide what to record, it does not add business context, and it does not change how anyone thinks. Most instrumented services emit span name, duration, and status, and nothing that tells you a premium customer just failed a $160 purchase. You have to say that part yourself.

So: use OTel as the transport. Keep the doctrine.

## Span attributes or log record: pick one, deliberately

A wide event is close to what you get from a well-attributed root span. If you already run OTel end to end and your backend queries span attributes comfortably, put the fields on the span and stop. That is the simplest correct answer.

Emit as a log record instead when any of these hold:

1. Logs are the durable audit record, retained on a different schedule than traces, and read by people who never open the tracing UI.
2. Traces are sampled at the head, so the unit you care about may not exist as a span.
3. The narrative is referenced by processes outside engineering (disputes, finance, compliance). Moving it into the trace stream solves a readability problem by creating an access problem.
4. Your span attribute limits truncate the events array (the SDK default cap on attribute count and value length will bite).

Traces answer "where in the topology". Wide events answer "what happened to this unit of work". They are complementary, not competing.

## The recommended wiring

1. Emit the wide event through the OTel logs API (`logs.Logger.Emit` / `OpenTelemetryAppender` / OTLP log record) so it carries `trace_id` and `span_id` automatically and rides the same collector pipeline.
2. Mirror a small subset onto the root span: `outcome`, `error.type`, the two or three highest-value business ids. Enough for the trace UI to be navigable and to jump to the event. Not the whole payload.
3. Put process-wide identity in the OTel `Resource`, not in every event: `service.name`, `service.version`, `deployment.environment`, `host.name`, `cloud.region`. This is the per-line stamp problem solved at the right layer, once.
4. Record `RecordException` plus `SetStatus(Error)` on the span at the same moment you write the immediate error line, so trace and log agree.

## Semantic conventions

Use OTel names where OTel already names the concept, exactly as spelled: `http.request.method`, `http.response.status_code`, `url.path`, `server.address`, `db.system.name`, `messaging.destination.name`, `error.type`, `rpc.method`. Inventing `httpMethod` next to `http.request.method` is how a shared dashboard becomes impossible.

Business fields are yours. Namespace them (`order.id`, `payment.provider`) and never squeeze them into a semconv key that means something else.

## Collector pipeline

- `batch` processor for throughput, `memory_limiter` to protect the host.
- `tailsampling` if the sampling decision must see the whole trace. See `sampling.md`.
- `transform`/`filter` for last-resort redaction, but treat that as a safety net and not the control. Redaction belongs in the emitter. See `pii.md`.
- Export logs and traces to the same backend when you can. Two backends means correlating by hand at 3 a.m.

## What OTel auto-instrumentation gives you and what it does not

Gives you: spans at framework and client boundaries, propagated context, resource detection. Take all of it.

Does not give you: the decision points inside your handler, business identifiers, feature flag state, the reason a fallback fired. That is the wide event, and it stays your job.
