# AWS: stdout to CloudWatch Logs

One JSON object per line on `stdout`, one line per unit of work. Lambda ships it, ECS ships it via `awslogs` or FireLens, EKS via Fluent Bit. Never call `PutLogEvents` from application code: you get throttling, retries, and a network dependency inside your request path for no benefit.

## Lambda

1. Turn on JSON log format (advanced logging controls: log format `JSON`, plus an application log level). The runtime then emits structured records instead of text lines, following the OpenTelemetry logs data model, and adds `timestamp`, `level`, `message`, and `requestId` without any library.
2. Include a valid RFC 3339 `timestamp` in your own payload. Without it Lambda stamps the record `INFO` and assigns its own time, which throws away your derived severity.
3. Verify once, with a real invocation, where your object lands. The runtime wraps application output, so your fields may sit under `message` rather than at the root, and the query shape differs between Node.js, Python, and Java runtimes. Pin the confirmed query into your runbook rather than guessing at 3 a.m.
4. Powertools for AWS Lambda (`Logger`) is the accumulator that already exists: `append_keys` accumulates line-level fields across the invocation, `inject_lambda_context` adds `function_request_id`, `cold_start`, and `xray_trace_id`, and one final emit gives you the wide event. The usual Powertools smell (context appended to every line) stops being a problem when there is only one line.
5. Add `faas.coldstart`, `faas.invocation_id`, and the memory configured. Emit before returning; a shutdown hook may never run when the sandbox freezes. See `workloads.md`.

Trace correlation: parse `_X_AMZN_TRACE_ID` (`Root=1-...;Parent=...;Sampled=1`) and put `Root` on the line. Insights also surfaces `@xrayTraceId` and `@xraySegmentId` automatically when a log line carries an X-Ray id.

## ECS, EKS, EC2

- `awslogs` driver sends each stdout line as one log event. Keep the event one line: a pretty-printed JSON payload becomes many events and your wide event is destroyed.
- FireLens or Fluent Bit when you want to fan out (CloudWatch for triage, S3 or OpenSearch for analytics). Do the redaction in the emitter anyway; see `pii.md`.
- Put `service.name`, `service.version`, and the task or pod id on the line. The log stream name is not a reliable substitute, and it is not queryable as a field.

## Limits that shape the payload

| Limit | Value | Consequence |
| --- | --- | --- |
| Log event size | 1,024 KB | Generous, but a truncated or rejected event is silent. Budget-test the payload (`testing.md`). |
| PutLogEvents batch | 1 MB | Only matters if you bypass stdout. Do not bypass stdout. |
| Insights fields per JSON event | 200 extracted | Beyond that you are back to `parse` on raw text. A wide event with 50 fields and a 47-entry array can exceed this; keep the entry attributes lean or nest them as a JSON string and use `jsonParse`. |
| Lambda JSON discovery | first embedded JSON fragment only | One object per line, exactly one. Two fragments and the second is invisible to field discovery. |
| Subscription filters | 5 per log group | Plan the fan-out (analytics sink, alerting, SIEM) inside that budget. |
| Metric filters | 100 per log group | Fine, but see the EMF cardinality warning below. |

Field discovery works only on Standard class log groups. Infrequent Access is cheaper and gives up the thing that makes wide events useful, so keep wide events in Standard.

## Querying with Logs Insights

System fields: `@message`, `@timestamp`, `@ingestionTime`, `@logStream`, `@log`. JSON fields use dot notation, and array positions are indexed (`events.0.desc`).

```
fields @timestamp, name, outcome, duration_ms, error.type
| filter name = "Checkout" and outcome != "ok"
| stats count() by error.type, service.version
| sort count() desc
```

Two things worth knowing before you write dashboards:

1. Dot notation only traverses genuinely nested JSON. If a field's value is a JSON-encoded string, use `jsonParse(field).sub` to reach into it.
2. Field indexes cut scan volume and cost on high-selectivity fields. Index `name`, `outcome`, and your main business id. You cannot index `@message`, `@timestamp`, or `@log`.

For analytics beyond triage, subscription filter to Firehose, land Parquet in S3, and query with Athena. CloudWatch Logs is a good incident tool and a poor warehouse.

## Metrics from wide events: EMF, carefully

Embedded metric format extracts metrics from the same JSON line, so one emit can feed both triage and dashboards:

```json
{
  "_aws": {
    "Timestamp": 1774348304000,
    "CloudWatchMetrics": [{
      "Namespace": "payments",
      "Dimensions": [["service", "name", "outcome"]],
      "Metrics": [{ "Name": "duration_ms", "Unit": "Milliseconds" }]
    }]
  },
  "service": "payments-api", "name": "Checkout", "outcome": "ok",
  "duration_ms": 75,
  "order.id": "ORD-4B7C2E",
  "events": [ ]
}
```

Rules that keep this from becoming a five-figure bill:

1. Dimension values must be root-level string members. Nested paths are not valid dimension targets.
2. Every unique dimension set creates a custom metric, and custom metrics are billed per metric. Never use `requestId`, `user.id`, or `order.id` as a dimension. That is the documented trap and it is easy to hit by accident.
3. Max 30 dimension keys per dimension set, max 100 metric definitions per document, 1 MB per document.
4. High-cardinality fields stay as plain members on the line. They are queryable in Insights and cost nothing extra.

Use `AWS/Logs` namespace metrics to confirm your EMF documents are actually being parsed rather than silently failing validation.

## Redaction

CloudWatch Logs data protection policies mask sensitive data at the log group level. Enable them as the safety net, keep the deny list in the emitter as the actual control. `pii.md` explains why the order matters.
