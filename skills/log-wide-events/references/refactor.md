# Refactoring a service that logs 48 lines per request

Nobody decided to log 48 times. Each line was added for a good reason, by a competent person, in a different PR, over several years. The volume was not designed, it accumulated. That is why "just log less" is useless advice: log less where, and who tells the author of line 31 that their line was the wasteful one?

Change the shape first. Prune second. In that order, always.

## 1. Measure the baseline (30 minutes)

Capture, for one unit of work in a pre-production environment:

- lines emitted per unit, and how many distinct loggers produced them
- bytes emitted per unit (UTF-8 over the raw line)
- bytes scanned by the query you actually run during an incident
- p50 and p99 duration of the unit, so you can prove the change is not slower

Without a baseline you get an opinion instead of a result. Write the four numbers in the PR description.

## 2. Find where the volume actually is (15 minutes)

Split one line into two parts:

```
2026-08-10 10:11:44.443 INFO [pay-7f3a91c4] AntifraudEvaluationService
[event-loop-thread-5] pod=payments-api-6d9f4c7b85-x2knq svc=payments-api ver=v2.14.3
az=sa-east-1a OrderId=ORD-4B7C2E MerchantId=MER-2F19A8 | Performing antifraud evaluation.
```

Everything before the `|` is the stamp. Everything after it is what happened. The stamp is charged once per line and is identical on every line carrying the same correlation id. To tell one story you pay for it 48 times.

Be precise about what shrinks, because this argument gets overstated: in a system like Loki, stream labels (`cluster`, `namespace`, `job`) are indexed once per stream, not once per line, so collapsing lines saves nothing there. What actually shrinks is the per-line stamp (timestamp, severity, logger name, thread, pod, version, zone), the business identifiers repeated in every payload, and the bytes your queries scan, which is separately billed.

## 3. Introduce the accumulator, keep the words (half a day)

- Add the unit and the entry point wrapper from the language reference.
- Replace `log.info("Performing antifraud evaluation.", attrs)` with `unit.add("Performing antifraud evaluation.", attrs)`. Same string, verbatim.
- Do not delete or reword a single message yet. Every existing query, alert, and dashboard that matches on message text keeps working, and that is the difference between a change you can ship incrementally and one that needs a coordinated switchover of alerting.
- Expect roughly one entry per old line on the first pass. 48 lines becoming 47 entries is a successful first pass, not a failure to prune.

## 4. Ship behind a flag, run both for a week

Both paths on, compare the numbers from step 1. Watch three things: the emitted line is not truncated by the pipeline, severity promotion actually fires (force a warn), and p99 did not move.

## 5. Prune (2 hours, and it is the bigger win)

Now the useless entries are visibly useless, sitting in one array in front of you. Apply the test: if this entry were missing from the story, would I notice, and would I be worse off? If no, it was never observability. It was a debug note someone left themselves while writing the code, and it has been billed monthly ever since.

Cut in this order: method entry/exit lines, paired intention/completion lines, restatements, then anything whose attributes duplicate a line-level field.

## 6. Promote the repeated attributes

Measure the composition of the resulting payload. In one published case, roughly a third of it was the same key repeated across entries: `OrderId` 19 times, `MerchantId` 17, `AuthorizationId` 12. Those are properties of the flow, not of individual steps. Promoting them to line level took that case from a 76.6% byte reduction to a projected 81.9%.

The rule that falls out: an attribute constant for the whole unit of work belongs on the line, not on the entry. Mechanically translating each old log line into an entry with the attributes it happened to carry gets this wrong by default.

## 7. Delete the old path and the flag

Then, per stakeholder pressure, publish the before and after. Two rows deserve comment when you do:

- bytes per line went **up** (77% in the published case). That is the mechanism, not a regression. If it did not go up, the change did not work.
- lines you did not convert did not move. Show that too. Before and after numbers that improve uniformly are usually measuring something other than what they claim.

## The framing that gets it approved

When volume hurts, the easy answers are raising the ingestion limit, sampling harder, or cutting retention. Three ways to throw information away or pay more. Sometimes paying is genuinely the right call. The question worth asking out loud: are we solving this, or are we paying to avoid solving it? It is worth knowing which one you picked.
