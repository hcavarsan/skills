# Java and Kotlin

Scope the accumulator with `ScopedValue` (finalized in JDK 25, JEP 506) or pass it as an explicit parameter. MDC is a bridge for a correlation id only, never the store: it breaks across thread pools, `CompletableFuture` hops, and reactive operators, and silently leaks values between requests when a pool thread is reused.

## The unit

```java
package obs;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.event.Level;
import org.slf4j.spi.LoggingEventBuilder;

import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class Unit {
    public record Entry(String desc, long offset_ms, String level, Map<String, Object> attrs) {}

    private static final Logger LOG = LoggerFactory.getLogger("wide");

    private final String name;
    private final long startNanos = System.nanoTime();
    private final Map<String, Object> line = new LinkedHashMap<>();
    private final List<Entry> events = Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger warns = new AtomicInteger();
    private final AtomicInteger errors = new AtomicInteger();
    private volatile Level level = Level.INFO;

    public Unit(String name) { this.name = name; }

    /** Constant for the whole unit: line level, never repeated per entry. */
    public Unit set(String key, Object value) { line.put(key, value); return this; }

    public void add(String desc) { add(desc, Level.INFO, Map.of()); }
    public void add(String desc, Map<String, Object> attrs) { add(desc, Level.INFO, attrs); }
    public void warn(String desc, Map<String, Object> attrs) { add(desc, Level.WARN, attrs); }

    /** Records the failure in sequence AND writes the immediate error line. */
    public void fail(Throwable t, Map<String, Object> attrs) {
        add(t.getClass().getSimpleName() + ": " + t.getMessage(), Level.ERROR, attrs);
        LOG.atError().addKeyValue("name", name)
           .addKeyValue("error.type", t.getClass().getName())
           .setCause(t)
           .log(name);
    }

    private void add(String desc, Level lvl, Map<String, Object> attrs) {
        events.add(new Entry(desc, elapsedMs(), lvl.name().toLowerCase(), attrs));
        if (lvl.toInt() > level.toInt()) level = lvl;
        if (lvl == Level.WARN) warns.incrementAndGet();
        if (lvl == Level.ERROR) errors.incrementAndGet();
    }

    /** Called once, from a finally block at the entry point. */
    public void emit(String outcome) {
        LoggingEventBuilder b = LOG.atLevel(level);
        line.forEach(b::addKeyValue);
        b.addKeyValue("name", name)
         .addKeyValue("outcome", outcome)
         .addKeyValue("duration_ms", elapsedMs())
         .addKeyValue("event_count", events.size())
         .addKeyValue("warn_count", warns.get())
         .addKeyValue("error_count", errors.get())
         .addKeyValue("events", List.copyOf(events))
         .log(name);
    }

    private long elapsedMs() { return (System.nanoTime() - startNanos) / 1_000_000; }
}
```

Requires an encoder that serializes SLF4J key-value pairs as JSON fields: `logstash-logback-encoder` 7.4+ (`<encoder class="net.logstash.logback.encoder.LogstashEncoder">`) or Logback 1.5's built-in `JsonEncoder`. Verify nested objects (the `events` list) serialize as JSON and not as `toString()`, because that silently turns your narrative into an unqueryable blob.

## Entry point (Spring MVC)

```java
public final class WideEventFilter extends OncePerRequestFilter {
    public static final ScopedValue<Unit> CURRENT = ScopedValue.newInstance();

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        Unit u = new Unit("HttpRequest")
                .set("http.request.method", req.getMethod())
                .set("http.route", route(req))
                .set("correlation_id", correlationFrom(req));

        ScopedValue.where(CURRENT, u).call(() -> {
            String outcome = "ok";
            try {
                chain.doFilter(req, res);
                outcome = res.getStatus() >= 500 ? "error" : "ok";
            } catch (Throwable t) {
                u.fail(t, Map.of());
                outcome = "partial";
                throw t;
            } finally {
                u.set("status_code", res.getStatus());
                u.emit(outcome);
            }
            return null;
        });
    }
}
```

`ScopedValue.where(...).call(op)` propagates checked exceptions, so the filter signature stays clean. On JDK 21 to 24, `ScopedValue` is a preview API: either enable preview or pass the `Unit` explicitly through the service layer. Explicit passing is not a downgrade; it makes the dependency visible.

Service code adds meaning only:

```java
Unit u = WideEventFilter.CURRENT.get();
u.set("user.id", user.id()).set("user.subscription", user.tier());
u.add("Cart resolved", Map.of("item_count", cart.items().size(), "total_cents", cart.totalCents()));
try {
    var charge = gateway.charge(cart);
    u.add("Charged", Map.of("payment.provider", charge.provider()));
} catch (GatewayException e) {
    u.fail(e, Map.of("payment.provider", "acme", "attempt", e.attempt()));
    throw e;
}
```

## Reactive, async, Kotlin

1. WebFlux and Reactor: `ScopedValue` and `ThreadLocal` do not cross operators. Put the unit in the Reactor `Context` with `contextWrite(ctx -> ctx.put(Unit.class, u))` and read it with `Mono.deferContextual`. Emit in `doFinally`, which fires on completion, error, and cancel.
2. Kotlin coroutines: carry it in a `CoroutineContext.Element`, never a `ThreadLocal`. `withContext(WideUnit(u)) { ... }`.
3. Virtual threads make one-unit-per-thread cheap, but do not go back to `ThreadLocal`; a `ScopedValue` is what virtual threads are designed for.
4. Keep a `MDC.put("correlation_id", id)` alongside the unit so third-party library lines you do not control remain joinable. Clear it in the same `finally`.

## Gotchas

1. `@Async` and executor submissions lose the scope. Wrap the task and pass the unit, or open a child unit named after the async job.
2. Kafka: emit per record in the consumer loop, not per poll batch. Batch level goes on its own unit with `record_count`.
3. Do not log inside `toString()` or entity getters. That is how a wide event ends up with 40 stray lines around it.
4. Never `catch (Exception e) { u.fail(e); }` without rethrowing. Recording is not handling.
