# Sampling

Sample only after the pattern is in place. Sampling first hides the problem; wide events plus sampling is how you keep both the bill and the truth.

## Decide after the unit finishes, never before

Head sampling (decide at request start) throws away the one request that explains the outage. Tail sampling decides once the outcome is known.

```
keep(event):
  if event.error_count > 0            -> keep, rate 1.0
  if event.outcome != "ok"            -> keep, rate 1.0
  if event.duration_ms > p99_threshold -> keep, rate 1.0
  if event.actor.tier in VIP          -> keep, rate 1.0
  if event.flags.new_checkout_flow    -> keep, rate 1.0   # watching a rollout
  otherwise                           -> keep with probability r
```

Five always-keep rules cover almost every real need: errors, non-ok outcomes, slow units, flagged actors, and units under an experiment. Everything else is the boring successful traffic, and 1% to 5% of it describes the happy path perfectly.

## Record the rate or your dashboards lie

Every kept event carries `sample_rate` (the probability it was kept). Aggregates multiply by `1/sample_rate`:

```sql
select name,
       sum(1.0 / sample_rate)                       as est_units,
       sum(if(outcome != 'ok', 1.0 / sample_rate, 0)) as est_failures
from events
where ts > now() - interval 1 hour
group by name
```

Without this field, a 1% sample of successes plus 100% of errors turns a 0.1% error rate into a 9% error rate on every chart. This is the single most common way sampled wide events mislead people.

## Where to put the decision

1. **In-process** is simplest and correct for one service. The emitter drops the event before serialization, so you also save the CPU.
2. **In the collector** (OTel Collector tail sampling processor, Vector, Fluent Bit) when you need the decision to consider the whole trace across services. Cost: the collector must buffer until the trace is complete, which needs memory and a decision window.
3. **Never in the backend.** By then you already paid for ingestion, which is the line item you were trying to cut.

Keep the two consistent: if the collector drops what the service kept, the `sample_rate` on the line is wrong.

## Consistent decisions across services

Hash the `trace_id` and compare against the rate rather than calling a random number generator per service. Same trace, same decision, so a sampled trace is not half present. This is what OTel's `TraceIdRatioBased` sampler does; mirror it in the event path.

## Dynamic rates

Fix a byte or event budget per service and let the rate float to fit it, recomputed every minute. That way traffic spikes cost latency in resolution, not money. Log the current rate as its own event once per minute so you can explain a gap in the data later.

## What never gets sampled

Errors. Audit-relevant state changes. Anything a dispute, regulator, or finance reconciliation reads. If the wide event is the audit trail, sampling it is not a cost decision, it is a compliance decision, and it needs the owner of that process to agree in writing.
