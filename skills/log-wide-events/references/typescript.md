# TypeScript (Node, Bun, Deno)

Accumulator lives in `AsyncLocalStorage`. Not a module-level variable, not a request object property you then have to thread through every function.

## The unit

```ts
// obs/wide.ts
import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

const log = pino({ level: "info", messageKey: "name" });
const RANK = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Sev = keyof typeof RANK;

type Entry = { desc: string; offset_ms: number; level: Sev; attrs?: Record<string, unknown> };

export class Unit {
  private readonly start = performance.now();
  private readonly line: Record<string, unknown> = {};
  private readonly events: Entry[] = [];
  private level: Sev = "info";
  private warns = 0;
  private errors = 0;

  constructor(readonly name: string, private readonly muted = false) {}

  /** Constant for the whole unit: line level, never repeated per entry. */
  set(key: string, value: unknown): void {
    this.line[key] = value;
  }

  add(desc: string, attrs?: Record<string, unknown>, level: Sev = "info"): void {
    this.events.push({ desc, offset_ms: Math.round(performance.now() - this.start), level, attrs });
    if (RANK[level] > RANK[this.level]) this.level = level;
    if (level === "warn") this.warns++;
    if (level === "error") this.errors++;
  }

  /** Records the failure in sequence AND writes the immediate error line. */
  fail(err: unknown, attrs?: Record<string, unknown>): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.add(`${e.name}: ${e.message}`, attrs, "error");
    log.error({ name: this.name, "error.type": e.name, stack: e.stack }, this.name);
  }

  /** Called once, from a finally block at the entry point. */
  emit(outcome: "ok" | "degraded" | "error" | "partial"): void {
    if (this.muted) return;
    log[this.level === "debug" ? "info" : this.level]({
      ...this.line,
      name: this.name,
      outcome,
      duration_ms: Math.round(performance.now() - this.start),
      event_count: this.events.length,
      warn_count: this.warns,
      error_count: this.errors,
      events: this.events,
    }, this.name);
  }
}

const store = new AsyncLocalStorage<Unit>();

/** Never throws. An un-instrumented path gets a muted unit. */
export const current = (): Unit => store.getStore() ?? new Unit("uninstrumented", true);

export async function withUnit<T>(name: string, fn: (u: Unit) => Promise<T>): Promise<T> {
  const u = new Unit(name);
  return store.run(u, async () => {
    try {
      const out = await fn(u);
      u.emit("ok");
      return out;
    } catch (err) {
      u.fail(err);
      u.emit("error");
      throw err;
    }
  });
}
```

## Entry point

```ts
// Hono, Express, and Fastify all reduce to the same three moves.
app.use(async (c, next) => {
  await withUnit("HttpRequest", async (u) => {
    u.set("http.request.method", c.req.method);
    u.set("http.route", c.req.routePath);
    u.set("correlation_id", c.req.header("x-correlation-id") ?? crypto.randomUUID());
    try {
      await next();
    } finally {
      u.set("status_code", c.res.status);
    }
  });
});
```

Handlers add meaning only:

```ts
app.post("/checkout", async (c) => {
  const u = current();
  u.set("user.id", user.id);
  u.set("user.subscription", user.subscription);
  u.add("Cart resolved", { item_count: cart.items.length, total_cents: cart.totalCents });

  const t = performance.now();
  const payment = await charge(cart);
  u.set("payment.latency_ms", Math.round(performance.now() - t));
  u.add("Charged", { "payment.provider": payment.provider, attempt: payment.attempt });

  return c.json({ order_id: payment.orderId });
});
```

## Gotchas

1. `console.log` is now a lint error in application code. Ban it (`no-console`) so the pattern cannot erode one PR at a time.
2. `AsyncLocalStorage` does not survive a `setTimeout` scheduled with a bare callback captured outside the `run`, and it does not survive worker threads. Detached background work gets its own unit.
3. Pino child loggers with per-request bindings are the per-line stamp problem. Keep one root logger and let the unit carry context.
4. Serverless: emit before the handler returns, not in a `process.on("beforeExit")` hook, which may never run. See `workloads.md`.
5. Do not put a `Response` object, a Prisma model, or anything with a cyclic reference into `attrs`. Project the two or three fields you actually query.
