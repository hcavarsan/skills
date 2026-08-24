# Python

Accumulator lives in a `contextvars.ContextVar`. Not a thread-local, not a global, not `logging` filters.

## The unit

```python
# obs/wide.py
from __future__ import annotations

import contextlib
import contextvars
import logging
import time
from dataclasses import dataclass, field
from typing import Any

_log = logging.getLogger("wide")
_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO,
           "warn": logging.WARNING, "error": logging.ERROR}


@dataclass
class Unit:
    name: str
    muted: bool = False
    start: float = field(default_factory=time.monotonic)
    line: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    level: int = logging.INFO
    warns: int = 0
    errors: int = 0

    def set(self, key: str, value: Any) -> None:
        """Constant for the whole unit. Line level, never repeated per entry."""
        self.line[key] = value

    def add(self, desc: str, level: str = "info", **attrs: Any) -> None:
        self.events.append({
            "desc": desc,
            "offset_ms": int((time.monotonic() - self.start) * 1000),
            "level": level,
            "attrs": attrs or None,
        })
        self.level = max(self.level, _LEVELS[level])
        self.warns += level == "warn"
        self.errors += level == "error"

    def fail(self, exc: BaseException, **attrs: Any) -> None:
        """Records the failure in sequence and writes the immediate error line."""
        self.add(f"{type(exc).__name__}: {exc}", "error", **attrs)
        _log.error(self.name, exc_info=exc,
                   extra={"wide": {"name": self.name, "error.type": type(exc).__name__}})

    def emit(self, outcome: str) -> None:
        if self.muted:
            return
        _log.log(self.level, self.name, extra={"wide": {
            **self.line,
            "name": self.name,
            "outcome": outcome,
            "duration_ms": int((time.monotonic() - self.start) * 1000),
            "event_count": len(self.events),
            "warn_count": self.warns,
            "error_count": self.errors,
            "events": self.events,
        }})


_current: contextvars.ContextVar[Unit | None] = contextvars.ContextVar("wide_unit", default=None)


def current() -> Unit:
    """Never raises. An un-instrumented path gets a muted unit."""
    return _current.get() or Unit(name="uninstrumented", muted=True)


@contextlib.contextmanager
def unit(name: str, **line: Any):
    u = Unit(name=name)
    u.line.update(line)
    token = _current.set(u)
    outcome = "ok"
    try:
        yield u
        outcome = "degraded" if u.warns else "ok"
    except BaseException as exc:
        u.fail(exc)
        outcome = "error"
        raise
    finally:
        u.emit(outcome)
        _current.reset(token)
```

The `finally` is the whole design. Every exit path emits, including cancellation and `SystemExit`.

## Entry point (ASGI, works with FastAPI, Starlette, Django ASGI)

```python
class WideEventMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        status = {"code": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        with unit("HttpRequest",
                  **{"http.request.method": scope["method"], "http.route": scope["path"]}) as u:
            u.set("correlation_id", correlation_from(scope))
            try:
                await self.app(scope, receive, send_wrapper)
            finally:
                u.set("status_code", status["code"])
```

Handlers add meaning only:

```python
@app.post("/checkout")
async def checkout(req: CheckoutRequest):
    u = current()
    u.set("user.id", user.id)
    u.set("user.subscription", user.tier)
    u.add("Cart resolved", item_count=len(cart.items), total_cents=cart.total_cents)
    try:
        charge = await gateway.charge(cart)
    except GatewayError as exc:
        u.fail(exc, **{"payment.provider": "acme", "attempt": exc.attempt})
        raise HTTPException(502)
    u.add("Charged", **{"payment.provider": charge.provider})
    return {"order_id": charge.order_id}
```

## Serializing

One JSON formatter, configured once at startup:

```python
import json
from datetime import datetime, timezone


class WideFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, timezone.utc)
        payload = {"ts": ts.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                   "level": record.levelname,
                   **getattr(record, "wide", {"msg": record.getMessage()})}
        if record.exc_info:
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, separators=(",", ":"))
```

Using structlog instead: bind nothing per line, keep the accumulator, and call `structlog.get_logger().log(level, name, **payload)` in `emit`. Do not use `bind()` to smear context across many lines; that is the per-line stamp you are trying to stop paying for.

## Gotchas

1. `contextvars` copy into a task at creation time. A task created inside the request sees the unit and can mutate it after the request emitted. Never hand the unit to a fire-and-forget task; pass plain values.
2. Celery, RQ, Dramatiq: open the unit inside the task function (or a base task's `__call__`), name it after the job, and put `retries` and `queue` on the line.
3. WSGI (Django, Flask): same design, use a middleware `__call__` with `try/finally`. `contextvars` work fine under threaded workers.
4. Delete `logging.Filter` classes that inject request context into every line. Their whole purpose was paying the stamp repeatedly.
5. `time.monotonic` for durations, never `time.time`, which jumps with clock sync.
