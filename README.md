# skills

[![ci](https://github.com/hcavarsan/skills/actions/workflows/ci.yml/badge.svg)](https://github.com/hcavarsan/skills/actions/workflows/ci.yml)
[![skills.sh](https://img.shields.io/badge/skills.sh-hcavarsan%2Fskills-000?logo=vercel&logoColor=white)](https://skills.sh/hcavarsan/skills)

<!-- The official install-count badge (https://skills.sh/b/hcavarsan/skills) renders
     "resource not found" until skills.sh has counted installs for this repo. Swap the
     shields badge above for it once the count is live:
     [![skills.sh](https://skills.sh/b/hcavarsan/skills)](https://skills.sh/hcavarsan/skills) -->

Agent skills I actually use. Each one is opinionated on purpose: it prescribes one way to do the thing and says out loud when the pattern is wrong.

## Install

Everything in the repo:

```bash
npx skills add hcavarsan/skills
```

One skill, by name:

```bash
npx skills add hcavarsan/skills --skill log-wide-events
```

List first, install nothing: `npx skills add hcavarsan/skills --list`.

Pull updates later with `npx skills update`.

## Skills

### log-wide-events

Instrument apps with wide events (canonical log lines) instead of line-by-line logging, in Go, Python, Java, TypeScript, Rust, or .NET. Covers new instrumentation and refactoring a service that already logs 48 lines per request, plus the cases where wide events are the wrong answer.

The skill body holds the doctrine and the decision procedure. Nineteen short reference files carry the per-case detail, so an agent reads only what the task needs:

| Area | Files |
| --- | --- |
| Design | `schema.md`, `checkpoints.md`, `severity-errors.md`, `workloads.md` |
| Languages | `go.md`, `python.md`, `java.md`, `typescript.md`, `other-runtimes.md` |
| Platforms | `gcp-cloud-logging.md`, `aws-cloudwatch.md`, `backends.md`, `otel.md` |
| Operations | `queries.md`, `sampling.md`, `refactor.md`, `pii.md`, `testing.md`, `review-checklist.md` |

Platform notes are grounded in the current vendor docs: Cloud Logging reserved `logging.googleapis.com/*` keys and the exact `LogSeverity` enum, the 256 KiB entry cap and entry splitting, Error Reporting payload requirements, CloudWatch Logs Insights dot notation with its 200-field extraction cap, field indexes, and the embedded metric format dimension rules that decide whether your metrics bill stays sane.

Sources behind the doctrine: [Wide Events](https://lfdubiela.github.io/wide-events/) by Luiz Dubiela, [Logging sucks](https://loggingsucks.com/) by Boris Tane, [Canonical Log Lines](https://brandur.org/canonical-log-lines) by Brandur Leach, and [Stripe's canonical log lines](https://stripe.com/blog/canonical-log-lines).

## Layout

```
skills/<skill-name>/SKILL.md          instructions plus frontmatter
skills/<skill-name>/references/*.md   loaded on demand
skills.sh.json                        grouping for the skills.sh repo page
scripts/lint-skills.mjs               validation, runs in CI
scripts/sync.sh                       copy a skill from ~/.agents/skills into the repo
```

## Adding or updating a skill

```bash
scripts/sync.sh log-wide-events   # copy from ~/.agents/skills, then lint
node scripts/lint-skills.mjs      # or lint on its own
```

The linter fails on anything that would break a consumer: frontmatter that YAML cannot parse as a plain scalar, a `name` that disagrees with its directory, a route to a reference file that does not exist, a JSON block that does not parse, a file over 2 MB, or a `skills.sh.json` group naming a skill this repo does not have. CI runs it on every push, then has the real `skills` CLI list and install from the checkout, because a skill with broken frontmatter is skipped with a warning rather than an error.

Consumers pick up changes with `npx skills update`. Nothing needs publishing: the CLI reads this repo directly, and new installs always fetch current contents.

## License

GPL-3.0. See `LICENSE`.
