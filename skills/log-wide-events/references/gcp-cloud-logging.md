# GCP: stdout to Cloud Logging

One JSON object per line on `stdout`, one line per unit of work. On Cloud Run, GKE, Cloud Run functions, and App Engine flex the integrated agent picks it up and parses it into `jsonPayload`. Do not call the Logging API from application code for normal volume: integrated stdout logging does not consume `entries.write` quota, and the API path adds a network dependency to your request path.

Text payloads land in `textPayload` and cannot be indexed by field. That alone rules them out.

## Special JSON keys the agent lifts out of your payload

Put these at the top level of the object. Everything else stays in `jsonPayload` and stays queryable.

| Your JSON key | Becomes `LogEntry` field | Use it for |
| --- | --- | --- |
| `severity` | `severity` | Derived line severity. Exact enum below. |
| `message` | display line in Logs Explorer | The unit name, so the collapsed row is readable. |
| `httpRequest` | `httpRequest` | `requestMethod`, `status`, `latency` ("0.075s"), `responseSize`, `remoteIp`. |
| `time` | `timestamp` | RFC 3339. Omit and Logging stamps arrival time. |
| `logging.googleapis.com/trace` | `trace` | `projects/PROJECT_ID/traces/TRACE_ID`. |
| `logging.googleapis.com/spanId` | `spanId` | 16 hex chars. |
| `logging.googleapis.com/trace_sampled` | `traceSampled` | Boolean. |
| `logging.googleapis.com/labels` | `labels` | Low-cardinality classification only. |
| `logging.googleapis.com/operation` | `operation` | `id` plus `producer` groups the stages of one flow in the Logs Explorer. `first`/`last` mark the ends. |
| `logging.googleapis.com/insertId` | `insertId` | Dedupe key and tie-breaker for ordering. |
| `logging.googleapis.com/sourceLocation` | `sourceLocation` | Only on the immediate error line. |

`operation` is the one people miss. Set `id` to your `correlation_id` and `producer` to the service, and the multi-stage flow from `checkpoints.md` collapses into a group in the UI for free.

## Severity: emit the exact enum

`DEFAULT`, `DEBUG`, `INFO`, `NOTICE`, `WARNING`, `ERROR`, `CRITICAL`, `ALERT`, `EMERGENCY`.

`WARN` is not in that list. The agent tries to match common strings, but relying on that is how a severity filter quietly misses your warnings. Map your internal level to the enum in the emitter: warn to `WARNING`, fatal to `CRITICAL`.

Severity is what log-based alerts, the Logs Explorer filter, and Error Reporting all key off, so the promotion rule from `severity-errors.md` is doing more work here than on any other platform.

## Example line

```json
{
  "severity": "WARNING",
  "message": "AuthorizationDecided",
  "time": "2026-08-24T10:11:44.443Z",
  "logging.googleapis.com/trace": "projects/acme-prod/traces/06796866738c859f2f19b7cfb3214824",
  "logging.googleapis.com/spanId": "000000000000004a",
  "logging.googleapis.com/trace_sampled": true,
  "logging.googleapis.com/operation": { "id": "pay-7f3a91c4", "producer": "payments-api" },
  "httpRequest": { "requestMethod": "POST", "status": 202, "latency": "0.075s" },
  "logging.googleapis.com/labels": { "env": "prod", "tenant_tier": "enterprise" },
  "name": "AuthorizationDecided",
  "outcome": "degraded",
  "duration_ms": 75,
  "event_count": 16, "warn_count": 1, "error_count": 0,
  "service.version": "v2.14.3",
  "order.id": "ORD-4B7C2E",
  "events": [ { "desc": "Antifraud evaluated", "offset_ms": 10, "level": "warn" } ]
}
```

Trace id comes from the `X-Cloud-Trace-Context` header (`TRACE_ID/SPAN_ID;o=1`) or W3C `traceparent`. Format it as `projects/PROJECT_ID/traces/TRACE_ID` and container logs nest under the Cloud Run request log, which is the correlation everyone wants and nobody configures.

## Errors and Error Reporting

Exceptions in stdout logs are captured by Error Reporting, but only if the payload looks right.

1. Stack trace goes in the `message` field of the immediate error line, in the language's native format. Cloud Logging parses it from there.
2. For an error with no stack trace, set `"@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"` and add `serviceContext: { service, version }`, with `severity: "ERROR"`.
3. Keep this on the separate immediate error line, not on the wide event. A stack trace inside an `events` array is not parsed, and stuffing it there loses the grouping.

Supported resource types include `cloud_run_revision`, `cloud_run_jobs`, `k8s_container`, `k8s_pod`, `cloud_function`, `gae_app`, `gce_instance`.

## Limits that shape the payload

| Limit | Value | Consequence |
| --- | --- | --- |
| `LogEntry` size | 256 KiB | An oversized entry gets split into a sequence carrying `split.uid`, `split.index`, `split.totalSplits`. Reassembling by hand during an incident is miserable, so stage the flow before you get there. |
| Labels per entry | 64, values 64 KiB | Labels are for classification. Business ids belong in `jsonPayload`. |
| Custom indexed fields | 20 per log bucket | Logging does full-text indexing, and Google advises against defining custom indexes. Do not plan around them. |
| Log-based metric labels | 10 per metric, 30,000 active time series | Never derive a metric label from `user.id` or `order.id`. That is the cardinality trap. |
| Ingestion rate | 4.8 GB/min in major regions, 300 MB/min elsewhere | Exclusion filters do not help: entries are excluded after the write. Sample in the application. See `sampling.md`. |

## Querying

Logs Explorer for triage:

```
resource.type="cloud_run_revision"
jsonPayload.name="Checkout"
jsonPayload.outcome!="ok"
jsonPayload."user.subscription"="premium"
```

Dotted key names need quoting in the query language, which is a decent argument for using nested objects (`user: { subscription }`) in the GCP payload rather than dotted flat keys. Pick one and put it in the schema module.

For anything analytical, upgrade the log bucket to Log Analytics and query with BigQuery standard SQL, or route a sink to BigQuery. Do not build dashboards on Logs Explorer; it is a triage tool. Query patterns in `queries.md`.
