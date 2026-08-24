# Workload patterns

Pick the unit of work first. Everything else follows from it. If you cannot name the unit, you are not ready to instrument.

| Workload | Unit of work | Emit point |
| --- | --- | --- |
| HTTP API | One request | Middleware `finally` |
| Queue consumer | One message | Around the handler, after ack or nack |
| Batch job | One item, plus one summary unit for the run | Per item, plus at run end |
| Stream processor | One window or one checkpoint interval | On window close |
| Cron or CLI | One invocation | Process exit path |
| Serverless | One invocation | Before returning, never after |
| Gateway or proxy | One proxied request | On response written |

## Queue consumers

- One event per message, never per poll batch. Add `messaging.destination.name`, `messaging.message.id`, `attempt`, `queue_time_ms` (enqueue timestamp to dequeue), and the ack decision.
- `outcome` values map cleanly: `ok` acked, `error` nacked to retry, `partial` crashed mid-handler, `degraded` acked after a fallback.
- Retries are separate units sharing a `correlation_id`. Do not accumulate across retries; the whole point is seeing attempt 3 fail differently from attempt 1.
- Poison message going to a DLQ deserves its own line at `ERROR` with the payload size and the parse failure, not silence.

## Batch jobs

Two levels, both needed:

1. Per item: one wide event each. This is what makes "which 14 of the 2 million rows failed and why" a single query.
2. Per run: one summary unit with `item_count`, `error_count`, `duration_ms`, and the run parameters. This is what the daily dashboard reads.

Sample the successful items hard (1% or less) and keep every failure. See `sampling.md`.

## Long-running and streaming work

This is the honest limit of the pattern. A wide event is emitted when a slice completes, so a 6 hour job or an open socket gives you no telemetry until it finishes, and none at all if it never does. Checkpoints soften this; they do not solve it.

What to do instead:

1. Emit progress units at real domain boundaries (per batch of 1000, per file, per window close), each a complete disjoint slice with its own `offset_ms` from the run start.
2. Keep a metric for liveness (`items_processed_total`, a heartbeat gauge). Metrics answer "is it alive"; wide events answer "what happened to that item".
3. For WebSockets and long streams: one unit for the connection lifecycle (open, close, duration, bytes, close reason) plus one unit per meaningful message class. Never one event per frame.

## Cron and CLI

- Unit is the invocation. Put `argv`, exit code, and the schedule name on the line.
- Emit on every exit path: success, handled failure, signal. Trap SIGTERM and emit `partial`, because Kubernetes evictions are the interesting case.
- CLI tools shipped to users: keep the human-readable output on stdout and the wide event on stderr or a file. Never mix the two streams.

## Serverless

- Emit before returning the response. A `beforeExit` or shutdown hook may never run when the runtime freezes the sandbox.
- Add `faas.invocation_id`, `faas.coldstart`, `faas.max_memory`, `billed_duration_ms`. Cold start correlation is one of the few things only the platform can tell you.
- Timeouts are the failure mode you most need. Set an internal alarm at 80% of the configured timeout that emits `partial` and keeps going, so a timeout produces evidence instead of silence.

## Fan-out inside one unit

Parallel calls (three upstreams at once) stay in one unit. Each records its own entry with its own `offset_ms`, so the overlap is visible in the offsets. Guard the accumulator for concurrent writes: mutex in Go, `synchronizedList` or `Atomic*` in Java, single-threaded event loop in Node makes it free.
