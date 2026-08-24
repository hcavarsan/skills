# Reviewing a logging PR

Read the diff against these. Anything failing 1 to 5 is a request for changes, not a nit.

## Blocking

1. **More than one emit per unit of work.** Count the emit calls and count the `logger.*` calls in handler code. Handlers add meaning; they never emit.
2. **No emit on the failure path.** If the emit is not in a `finally`, `defer`, `ensure`, `after`, or `Drop`, the units that crashed are invisible.
3. **Hardcoded level on the emit.** Severity is derived from the accumulated entries. A literal `INFO` there is how an error rate silently goes to zero.
4. **Error recorded but no immediate line with the stack trace**, or an error caught and recorded without rethrowing.
5. **Sensitive field added.** Card data, tokens, headers, whole bodies, free-text user input. See `pii.md`.

## Request changes

6. **String literals as field keys** instead of the schema module's constants.
7. **Data in the message string** (`f"charged {user} for {amount}"`) instead of fields.
8. **Attributes constant for the unit repeated in every entry.** Promote to line level.
9. **`offset_ms` computed as a delta from the previous entry** instead of from unit start.
10. **Entries that fail the value test:** method entry and exit, paired intention/completion, restatements, anything the author left for themselves while writing the code.
11. **Accumulator in a thread-local, a global, or MDC.** Breaks across pools, async hops, and reactive chains, and leaks between requests.
12. **A unit handed to a background task** that can outlive the emit.
13. **Stage names that need the code to understand:** `Checkpoint2`, `AfterServiceCall`, `Phase1`.
14. **New required field with no default** for events emitted before it is set. A missing key in half the rows breaks every query on it.

## Ask, do not block

15. Is this stage genuinely a business stage, or is one event the right answer? Default is one.
16. Should this field be a real column in the backend, or is the attribute map fine? Depends on whether anyone filters on it.
17. Does the sampling rule keep this unit? Errors, slow, VIP, and experiment traffic must be exempt.
18. Is the event still under the pipeline's byte cap with this addition?

## Praise, so the pattern spreads

Reviewers usually only speak up about problems, and that is part of why line-by-line logging accumulated in the first place. Say so out loud when a PR deletes ten log lines and adds one entry, promotes a repeated attribute to line level, or names a stage in a way a support agent would understand. Those are the changes that make the next incident short.
