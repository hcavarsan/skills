# Rust, .NET, Ruby, Elixir, PHP

Same three moves everywhere: request-scoped accumulator, handlers add meaning, one emit in the unwind path. Only the scoping primitive changes.

## Rust

- Scope: put the unit in the request extensions (`axum::Extension`, `tower` layer) or a `tokio::task_local!`. Both are explicit; neither leaks across tasks.
- Concurrency: `Arc<Mutex<Unit>>` if the handler forks work with `join!`, otherwise `&mut Unit` passed down is cheaper and the borrow checker keeps the lifetime honest.
- Emit: a `tower::Layer` whose future emits in `Drop` covers panics and cancellation, which is the Rust equivalent of `finally`. Cancellation is the common one: a client that hangs up drops the future, and `Drop` is the only place you still get the story.
- Serialization: `serde::Serialize` on the unit, then one `tracing::event!(level, wide = %json)` or a `tracing_subscriber` JSON layer. Do not emit `tracing` events per step; that is the pattern you are removing.
- Level: `tracing` levels are compile-time filtered, so compute the level and use `event!` with a dynamic level via a match on three arms, not a runtime variable.

## .NET

- Scope: register the unit as a scoped service in DI (`services.AddScoped<Unit>()`) and inject it. That is the idiomatic request scope and it beats `AsyncLocal<T>`, which you only need for library code with no DI access.
- Entry point: a middleware component with `try/catch/finally`, plus `IHostedService` wrappers for background jobs.
- Emit: `ILogger.Log(level, "{name}", ...)` with a state object, or Serilog with `LogEventLevel` computed from the accumulator. With Serilog, use destructuring (`@events`) so the array serializes as JSON instead of `ToString()`.
- Watch: `ILogger` scopes (`BeginScope`) smear context across many lines. That is the per-line stamp. Keep one emit.

## Ruby

- Scope: `ActiveSupport::CurrentAttributes` (fiber-safe, reset per request by Rails) or a Rack middleware storing on `env`. Never a bare `Thread.current` hash, which leaks under Puma thread reuse.
- Entry point: Rack middleware with `ensure`. Sidekiq: a server middleware around `yield`.
- Precedent: `lograge` already collapses Rails request logs into one line. Wide events are lograge plus business context plus an events array, so extend it rather than adding a parallel path.
- Emit: one `logger.info(payload.to_json)` with a JSON formatter, level computed from the accumulator.

## Elixir

- Scope: the process dictionary is genuinely per-request here, because each request is its own process. `Logger.metadata/1` is fine for the line-level fields.
- Entry point: a `Plug` that wraps the rest of the pipeline and registers `Plug.Conn.register_before_send/2`, plus a `try/after` for crashes. Phoenix telemetry events (`[:phoenix, :endpoint, :stop]`) give you duration for free.
- Emit: one `Logger.log(level, name, metadata)` with a JSON backend. Do not spawn a task holding the accumulator; the parent may finish first.
- Broadway and Oban: one unit per message or job, named after the job, with `attempt` and `queue` on the line.

## PHP

- Scope: a request-scoped service in the container (Laravel singleton bound per request, Symfony `request` scope). PHP-FPM gives you a fresh process per request, so a static accumulator also works, but the container binding survives the move to Swoole or RoadRunner.
- Entry point: middleware with `try/finally`, plus `register_shutdown_function` as the backstop for fatal errors, which is the one path middleware cannot catch.
- Emit: one Monolog record with the payload in `context`, JSON formatter, level from the accumulator.
- Queue workers (Horizon, Messenger): one unit per job. Reset the accumulator between jobs, because the worker process is long lived.
