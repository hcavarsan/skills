# One event or several

Default to one event per service per unit of work. That is the canonical form and it is correct for most services. Split only when the domain forces it.

## The naming test

Can you name the stage without referring to code?

- Passes: `OrderValidated`, `AuthorizationDecided`, `PaymentCompleted`. A person who has never opened the repo knows what happened.
- Fails: `Checkpoint2`, `AfterServiceCall`, `Phase1Done`. A stage you cannot name in domain language will not survive the next refactor, because nothing anchors it.

Nobody has ever answered "what happened to this transaction" with "the first 26 steps went fine". Stages are business stages, not time intervals and not entry counts.

## Split when at least one of these is true

1. **The unit crosses an async boundary.** A queue hop or a handoff to another component means the second half may never run. Each stage is emitted by the component that owns it.
2. **Durability under load is why you started.** Disjoint stages mean a dropped line costs one stage, not the whole story. Empty the accumulator on every emit so no entry appears twice.
3. **A flow that dies must leave evidence.** A single event at the end only exists if there is an end. Crash, timeout, or poison message and a one-event design gives silence for exactly the units you most need. With stages you get everything up to the last emit, and the missing next one is itself the signal.
4. **The payload is getting large.** 47 entries with attributes is a big line and plenty of pipelines truncate at a fixed size. A truncated wide event is worse than several intact ones, because you lose the tail silently. Set `truncated: true` if you clip on purpose.
5. **The stage boundary is also an ownership boundary.** When stages line up with the components that own them, that is the sign the boundary is in the right place.

## The trade you are making

Three lines means paying the per-line stamp three times instead of once, and reassembling the flow means fetching three lines instead of one. Worth it when durability under load or async boundaries are the reason. Not worth it to hit a number.

Get the stages right and the count falls out by itself. A card authorization produced three. A capture with a settlement leg produces four. A simple read produces one, and one is correct. Do not invent stages to look thorough.

## Wiring stages together

- Same `correlation_id` on every stage. Same `trace_id` if tracing is on.
- `name` is the stage name. Keep a `unit.name` field if you also need the parent flow name.
- Each stage carries its own `offset_ms` window relative to the unit start it knows about, plus its own `duration_ms`.
- `outcome: partial` marks a stage emitted from an exception path before its natural end.
