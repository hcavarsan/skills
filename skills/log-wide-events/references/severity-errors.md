# Severity, errors, outcomes

The single most expensive mistake in this pattern: a failure becomes one entry inside an `events` array on a line stamped `INFO`. Severity alerts stop firing, the error tracker sees nothing, the `level=error` dashboard goes quiet, and the graph everyone trusts shows an improvement that is entirely an artifact of your logging change. You drove the error rate to zero by making errors unobservable.

Three rules prevent it.

## 1. The line inherits the highest severity it carries

```
level = max(severity of every accumulated entry, default INFO)
```

One `WARN` entry and the line is `WARN`. One error and it is `ERROR`. Severity keeps meaning what it always meant: is there something in here a human should look at. Every alert, filter, and dashboard keyed on level keeps working without knowing the format changed, which is what makes the migration shippable without touching alerting.

## 2. Errors are also emitted immediately, on their own line

Severity promotion alone is not enough, for two reasons. The stack trace belongs on its own line rather than stuffed into a description string, and an exception may prevent the emit from ever happening.

So on an error: write the error line now, exactly as the old code did, **and** record the entry into the accumulator so the narrative stays complete with the failure in sequence and with its offset.

Yes, the error appears twice. That duplication is deliberate and cheap, because errors are rare. Optimizing the byte count of the error path is optimizing the wrong thing.

## 3. Counts and outcome live at line level

```json
{ "name": "AuthorizationDecided", "level": "WARN",
  "event_count": 16, "warn_count": 1, "error_count": 0,
  "outcome": "degraded", "status_code": 202, "events": [ ] }
```

This is what makes the interesting questions cheap: which flows completed but carried a warning, what is the error rate by stage, which clients see degraded outcomes. All field filters, no JSON parsing in the query path.

## Emit on the way out of a failure

If an exception escapes before the next emit point, emit what you have and mark it `outcome: partial`. The accumulated entries are most valuable precisely when the flow did not finish. A `finally` that emits is the difference between having that story and losing it.

Catch-and-emit must never swallow: record, emit, rethrow.

## Outcome values

Use exactly these four. More values means every consumer needs a mapping table.

| Value | Meaning |
| --- | --- |
| `ok` | Completed as intended. Zero error entries. |
| `degraded` | Completed, but carried a warn: a retry, a fallback, a cache miss that cost latency, a partial result returned to the caller. |
| `error` | Did not complete. The caller got a failure. |
| `partial` | Emitted from an exception or shutdown path before the unit's natural end. |

## Entry levels versus line levels

Entries may carry `debug`, `info`, `warn`, `error`. Lines carry `INFO`, `WARN`, `ERROR` only.

`debug` entries are the replacement for debug logging: they ride inside the payload, so they cost no extra per-line stamp, and they are gated by a per-unit verbose flag (a header, a feature flag, a sampled percentage) rather than a global log level. Debug entries never promote line severity.

Map to the platform's vocabulary in the emitter, not at the call site. Cloud Logging's enum is `DEBUG`, `INFO`, `NOTICE`, `WARNING`, `ERROR`, `CRITICAL`, `ALERT`, `EMERGENCY`, so a line stamped `WARN` is relying on best-effort string matching and can drop out of a severity filter. See `gcp-cloud-logging.md` and `aws-cloudwatch.md`.
