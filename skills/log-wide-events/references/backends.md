# Backends

The pattern assumes you can filter and group on fields with many distinct values. Where that assumption breaks, the shape of the event has to change. Check your backend before writing the schema.

## Columnar stores: ClickHouse, BigQuery, Snowflake, DuckDB

The best fit. High cardinality and high dimensionality are what these are built for.

- Materialize the fields you query constantly (`outcome`, `name`, `status_code`, `duration_ms`, `service.version`) as real typed columns. Keep the rest in a `Map(String, String)` or JSON column.
- ClickHouse: `ORDER BY (service_name, name, toStartOfHour(ts))` for the usual triage pattern, `events` as a `String` holding JSON, and `JSONExtract` only in the drill-down path. Use `Map` with `mapKeys` indexes for the long tail. TTL to object storage rather than deleting.
- BigQuery: partition by `DATE(ts)`, cluster by `service_name, name, outcome`. Store `events` as `JSON` (queryable) rather than `STRING`. Watch bytes scanned, since that is the bill.
- Because the whole narrative is one row, the drill-down is a single row read instead of a 48-row scan. That is where the "bytes scanned down 89%" number comes from.

## Loki

Works, with one hard constraint: labels must stay low cardinality. `service`, `env`, `namespace`, `level`. Never `user_id`, never `order_id`, never `trace_id` as a label.

- Put everything else inside the JSON line and query with `| json | outcome="error" | duration_ms > 2000`.
- Label cardinality explosion is the failure mode, and it takes the cluster down, not just the query.
- Note the honest correction to the volume argument: stream labels are indexed once per stream, not per line, so collapsing lines does not shrink label storage. What shrinks is the per-line stamp, the repeated business ids, and the bytes each query scans.

## Datadog, Honeycomb, New Relic, Splunk

- Honeycomb is the closest thing to a native wide-event backend. Emit the event as a span with all attributes and use `BubbleUp`. No translation needed.
- Datadog: facets have to be created for fields you want to filter on, and custom metrics generated from logs are billed separately. Keep the required line fields as facets and leave `events` unfaceted.
- Splunk: index the line, accelerate a data model over the required fields, use `spath` for the drill-down.
- Watch the per-event attribute count limits and the per-line byte cap on all of these. Exceeding it truncates silently, which is exactly the failure mode that makes a big event worse than several small ones.

## Elasticsearch and OpenSearch

- Mapping explosion is the risk: every new attribute key becomes a field in the mapping. Set `dynamic: false` for the `events` subtree and use `flattened` for open-ended attribute maps.
- Keep the required line fields explicitly mapped and typed. Never let a numeric arrive as a string once and pin the mapping wrong.

## Managed cloud platforms

On Cloud Run, GKE, Lambda, ECS, and EKS the emit path is `stdout` and a platform parser sits between your process and the store. That parser has its own reserved keys, severity vocabulary, size caps, and field-discovery limits, and getting them wrong costs you queryability rather than throwing an error.

- Google Cloud: `references/gcp-cloud-logging.md`. Reserved `logging.googleapis.com/*` keys, the exact `LogSeverity` enum, Error Reporting formatting, 256 KiB entry cap, log-based metric cardinality limits.
- AWS: `references/aws-cloudwatch.md`. Lambda JSON log format, Logs Insights dot notation and its 200-field extraction cap, field indexes, EMF metrics and the dimension cardinality trap.

## The line to draw

If your store indexes low-cardinality labels and brute-forces everything else, you will feel it on every query. Two options: keep the events narrow and put the analytical copy in a columnar store, or move. Do not pretend the query pattern will be fine.
