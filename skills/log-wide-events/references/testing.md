# Testing instrumentation

Instrumentation is production behavior. It breaks silently, and it breaks exactly when you need it. Four tests are enough, and they are cheap.

## 1. Golden event, one per unit of work

Run the handler against fakes, capture the emitted event, snapshot it after replacing volatile fields (`ts`, `duration_ms`, `offset_ms`, ids) with placeholders. Assert the whole shape.

```python
def test_checkout_emits_one_event(capture_wide, fake_gateway):
    client.post("/checkout", json=ORDER)

    assert len(capture_wide.events) == 1          # the rule that matters most
    e = capture_wide.events[0]
    assert e["name"] == "Checkout"
    assert e["outcome"] == "ok"
    assert e["level"] == "INFO"
    assert e["user.subscription"] == "premium"
    assert [x["desc"] for x in e["events"]] == ["Cart resolved", "Charged"]
```

The `len(...) == 1` assertion is the one that catches regressions, because the way this pattern dies is somebody adding a `logger.info` back into a handler.

## 2. Failure path

Force the dependency to fail and assert four things: the event still exists, `outcome == "error"`, `level == "ERROR"`, and a separate line carried the stack trace. The `finally` emit is the highest-value line of code in the whole design, so it gets a test.

Add the warn-only case: one warn entry means `level == "WARN"`, `warn_count == 1`, `outcome == "degraded"`. That is what keeps severity alerts alive.

## 3. Schema contract test

One test over the required field list, run for every unit of work in the service:

```go
func TestRequiredFields(t *testing.T) {
	for _, ev := range captured {
		for _, k := range obs.RequiredLineFields {
			if _, ok := ev[k]; !ok {
				t.Errorf("%s missing required field %s", ev["name"], k)
			}
		}
	}
}
```

Extend it with type assertions (`duration_ms` is a number, `outcome` is one of four values) and a deny-list check that no forbidden key appears anywhere in the payload, including nested `attrs`. That last one is your PII regression test.

## 4. Budget test

Serialize a representative event and assert its byte size is under the pipeline's truncation limit, with headroom. A truncated wide event loses its tail silently, which is worse than several intact lines. Run it in CI so a new field that pushes a payload over the cliff fails the build instead of the incident.

Optional and worth it under load: a benchmark asserting the emit path allocates and costs what you think. One serialization per unit is cheap, but a naive implementation that copies the attribute map three times is not.

## Lints, not tests

- Ban the raw logger in application code: `no-console` (TS), a forbidden-import lint on `log`/`logging` in handler packages (Go, Python), an ArchUnit rule (Java). Whitelist the emitter module and the entry point.
- Ban string interpolation into log messages, so data cannot go back into the message text.
- Require field constants: fail on a literal string key in `set`/`add` calls where the schema module has a constant.

These three lints do more to keep the pattern alive over two years than any amount of documentation.
