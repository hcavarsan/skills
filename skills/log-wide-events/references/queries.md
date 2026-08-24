# Day 2: querying, alerting, dashboards

The payoff is that triage stops being archaeology. Instead of "grep 50 services and hope", you ask one question and get an answer. Every query below assumes the required line fields from `schema.md`.

## The four queries that cover most incidents

```sql
-- 1. What happened to this one unit of work
select * from events where correlation_id = 'pay-7f3a91c4' order by ts;

-- 2. What is failing right now, and how
select name, error_type, count() as n
from events
where ts > now() - interval 15 minute and outcome != 'ok'
group by name, error_type order by n desc;

-- 3. Who is affected, and do they matter
select user_subscription, count() as failures, sum(cart_total_cents) as blocked_cents
from events
where ts > now() - interval 1 hour and outcome = 'error' and name = 'Checkout'
group by user_subscription;

-- 4. Is it the deploy
select service_version, countIf(outcome != 'ok') / count() as failure_rate, quantile(0.99)(duration_ms)
from events
where ts > now() - interval 2 hour and name = 'Checkout'
group by service_version;
```

Query 4 is the one that pays for the whole migration. It only works because `service.version` is on every event.

## The narrative drill-down

The summary is the default view, the step-by-step is one click away:

```
OrderValidated       payments-api   event_count 26   0 to 47 ms
AuthorizationDecided auth-service   event_count 16   49 to 71 ms
PaymentCompleted     payment-worker event_count  5   73 to 75 ms   202
```

Then expand one line to read the entries with their offsets. The latency profile of the flow is inside the line, so nobody subtracts timestamps across 48 rows anymore.

## Alerting

1. Alert on `outcome` and `error_count`, never on message text. Text is for humans reading the narrative; fields are for machines.
2. Keep the severity-based alerts you already have. Severity promotion is what makes that work without rewriting them.
3. Rate, not count: `countIf(outcome='error') / count()` over a window, with a minimum volume guard so a 1-of-1 failure at 4 a.m. does not page anyone.
4. Alert on `outcome = 'partial'` separately. That is the crash and timeout signal, and it is usually the earliest one you get.
5. A stage that stops arriving is an alert: if `AuthorizationDecided` counts drop to zero while `OrderValidated` keeps flowing, the flow is stuck between them. The missing next stage is itself the signal.

## SLOs from events

`outcome in ('ok','degraded')` is your availability numerator. `duration_ms` percentiles are your latency SLI. Both come from the same rows, so the SLO and the debugging data can never disagree, which is not true when the SLO comes from metrics and the debugging from logs.

Remember the sampling weight (`1/sample_rate`) in every aggregate. See `sampling.md`.

## Dashboards

Four panels beat forty: units per minute by `name`, failure rate by `name`, p50/p95/p99 `duration_ms`, and top `error.type`. Everything else is a saved query someone runs during an incident, not a panel someone stares at.

## Metrics still exist

Wide events do not replace counters for high-frequency, low-value signals (GC pauses, connection pool gauges, queue depth). They replace the log lines that were pretending to be observability. Keep metrics for liveness and cheap trends; use events for anything you would want to slice by a business dimension.
