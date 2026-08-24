# Go

Accumulator lives in `context.Context`. Nothing else. No package-level global, no goroutine-local hack.

Requires Go 1.21+ for `log/slog`, 1.24+ for `slog.DiscardHandler` (swap in a handler over `io.Discard` on older versions).

## The unit

```go
package obs

import (
	"context"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"
)

type ctxKey struct{}

type entry struct {
	Desc     string         `json:"desc"`
	OffsetMs int64          `json:"offset_ms"`
	Level    string         `json:"level"`
	Attrs    map[string]any `json:"attrs,omitempty"`
}

type Unit struct {
	mu      sync.Mutex // handlers fan out into goroutines; the unit is shared state
	log     *slog.Logger
	name    string
	start   time.Time
	line    map[string]any
	entries []entry
	level   slog.Level
	warns   int
	errs    int
	muted   bool
}

func Start(ctx context.Context, log *slog.Logger, name string) (context.Context, *Unit) {
	u := &Unit{log: log, name: name, start: time.Now(), level: slog.LevelInfo, line: map[string]any{}}
	return context.WithValue(ctx, ctxKey{}, u), u
}

// From never returns nil. An un-instrumented call path degrades to a discard
// unit instead of panicking in production.
func From(ctx context.Context) *Unit {
	if u, ok := ctx.Value(ctxKey{}).(*Unit); ok {
		return u
	}
	return &Unit{log: slog.New(slog.DiscardHandler), start: time.Now(), muted: true}
}

// Set records a value that is constant for the whole unit: line level, never
// repeated per entry.
func (u *Unit) Set(k string, v any) {
	u.mu.Lock()
	u.line[k] = v
	u.mu.Unlock()
}

// Add replaces log.Info inside handlers.
func (u *Unit) Add(desc string, attrs map[string]any)  { u.add(slog.LevelInfo, desc, attrs) }
func (u *Unit) Warn(desc string, attrs map[string]any) { u.add(slog.LevelWarn, desc, attrs) }

// Fail records the failure in sequence and writes the immediate error line
// with the stack trace. Both, on purpose.
func (u *Unit) Fail(err error, attrs map[string]any) {
	u.add(slog.LevelError, err.Error(), attrs)
	u.log.Error(err.Error(),
		slog.String("name", u.name),
		slog.String("error.type", errType(err)),
		slog.String("stack", string(debug.Stack())))
}

func (u *Unit) add(l slog.Level, desc string, attrs map[string]any) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.entries = append(u.entries, entry{
		Desc:     desc,
		OffsetMs: time.Since(u.start).Milliseconds(),
		Level:    l.String(),
		Attrs:    attrs,
	})
	if l > u.level {
		u.level = l
	}
	switch l {
	case slog.LevelWarn:
		u.warns++
	case slog.LevelError:
		u.errs++
	}
}

// Emit runs once, from a defer at the entry point.
func (u *Unit) Emit(ctx context.Context, outcome string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.muted {
		return
	}
	args := make([]any, 0, len(u.line)+6)
	for k, v := range u.line {
		args = append(args, slog.Any(k, v))
	}
	args = append(args,
		slog.String("outcome", outcome),
		slog.Int64("duration_ms", time.Since(u.start).Milliseconds()),
		slog.Int("event_count", len(u.entries)),
		slog.Int("warn_count", u.warns),
		slog.Int("error_count", u.errs),
		slog.Any("events", u.entries),
	)
	u.log.Log(ctx, u.level, u.name, args...)
}
```

## Entry point

```go
func Middleware(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, u := obs.Start(r.Context(), log, "HttpRequest")
			sc := trace.SpanContextFromContext(ctx)
			u.Set("trace_id", sc.TraceID().String())
			u.Set("correlation_id", correlationFrom(r))
			u.Set("http.request.method", r.Method)
			u.Set("http.route", routePattern(r))

			rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
			outcome := "ok"
			defer func() {
				if p := recover(); p != nil {
					u.Fail(fmt.Errorf("panic: %v", p), nil)
					rec.code, outcome = http.StatusInternalServerError, "partial"
				}
				u.Set("status_code", rec.code)
				u.Emit(ctx, outcome)
			}()

			next.ServeHTTP(rec, r.WithContext(ctx))
			outcome = outcomeFor(rec.code, u)
		})
	}
}
```

Handlers only add meaning:

```go
func (h *Handler) Checkout(w http.ResponseWriter, r *http.Request) {
	u := obs.From(r.Context())
	u.Set("user.id", user.ID)
	u.Set("user.subscription", user.Tier)
	u.Add("Cart resolved", map[string]any{"item_count": len(cart.Items), "total_cents": cart.TotalCents})

	if err := h.pay.Charge(r.Context(), cart); err != nil {
		u.Fail(err, map[string]any{"payment.provider": "acme", "attempt": attempt})
		http.Error(w, "payment failed", http.StatusBadGateway)
		return
	}
	u.Add("Charged", map[string]any{"payment.provider": "acme"})
}
```

## Gotchas

1. Never pass a `*Unit` into a goroutine that outlives the request. It will mutate a unit already emitted. Pass values, or give the goroutine its own unit.
2. Interceptors, not handlers, own `Emit`. gRPC: one `UnaryInterceptor`, plus a `StreamInterceptor` that emits per stream, not per message.
3. `slog` with a JSON handler only. A text handler defeats the point.
4. Do not use `slog.Default()` inside libraries. Inject the logger once at startup and pass it.
5. Fan-in helpers (`errgroup`) should call `u.Add` from each goroutine. That is what the mutex is for.
