#!/usr/bin/env node
// Lints every skill in ./skills plus skills.sh.json. Zero dependencies.
// Exits 1 on any error. Warnings never fail the build.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, "skills");
const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

// Plain YAML scalars break on these. A colon followed by a space turns the value
// into a nested mapping, which is what silently hides a skill from the CLI.
const YAML_HAZARDS = [
  [/:\s/, "contains a colon followed by whitespace (quote the value or reword)"],
  [/\s#/, "contains ' #' which starts a YAML comment"],
  [/^["'[{&*!|>%@`]/, "starts with a YAML indicator character"],
];

const STYLE = [
  [/\u2014/g, "em dash"],
  [/\u2013/g, "en dash"],
  [/[\u201c\u201d]/g, "curly double quote"],
  [/[\u2018\u2019]/g, "curly single quote"],
  [/[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/gu, "emoji"],
];
const SLOP = /\b(crucial|delve|leverage|tapestry|seamless|showcase|pivotal|holistic|robust)\b/gi;

function parseFrontmatter(text, where) {
  if (!text.startsWith("---\n")) {
    err(where, "missing YAML frontmatter opening ---");
    return null;
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    err(where, "unterminated YAML frontmatter");
    return null;
  }
  const fields = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) {
      err(where, `frontmatter line is not a simple key/value pair: ${line.slice(0, 60)}`);
      continue;
    }
    const [, key, raw] = m;
    fields[key] = raw;
    const quoted = /^(".*"|'.*')$/.test(raw.trim());
    if (!quoted) {
      for (const [re, why] of YAML_HAZARDS) {
        if (re.test(raw)) err(where, `frontmatter '${key}' ${why}`);
      }
    }
  }
  return fields;
}

function lintProse(file, text) {
  const where = relative(ROOT, file);
  for (const [re, label] of STYLE) {
    const hits = text.match(re);
    if (hits) err(where, `${hits.length} ${label}(s); rewrite without them`);
  }
  const slop = [...new Set((text.match(SLOP) || []).map((s) => s.toLowerCase()))];
  if (slop.length) warn(where, `AI-vocabulary words: ${slop.join(", ")}`);

  let i = 0;
  for (const block of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    i++;
    try {
      JSON.parse(block[1]);
    } catch (e) {
      err(where, `json block ${i} does not parse: ${e.message}`);
    }
  }
}

function lintSkill(dir) {
  const name = dir;
  const base = join(SKILLS_DIR, dir);
  const skillFile = join(base, "SKILL.md");
  const where = relative(ROOT, skillFile);
  if (!existsSync(skillFile)) return err(relative(ROOT, base), "no SKILL.md");

  const text = readFileSync(skillFile, "utf8");
  const fm = parseFrontmatter(text, where);
  if (fm) {
    if (!fm.name) err(where, "frontmatter is missing 'name'");
    else if (fm.name !== name) err(where, `frontmatter name '${fm.name}' does not match directory '${name}'`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) err(where, "directory name must be lowercase kebab-case");
    if (!fm.description) err(where, "frontmatter is missing 'description'");
    else {
      const len = fm.description.length;
      if (len < 40) err(where, `description is ${len} chars; too short to trigger reliably`);
      if (len > 2000) err(where, `description is ${len} chars; trim it`);
    }
  }

  const lines = text.split("\n").length;
  if (lines > 500) warn(where, `${lines} lines; move detail into references/ for progressive disclosure`);

  // Every referenced doc must exist, and every doc must be reachable from SKILL.md.
  const refDir = join(base, "references");
  const onDisk = existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith(".md")) : [];
  const routed = new Set([...text.matchAll(/`references\/([a-z0-9.-]+\.md)`/g)].map((m) => m[1]));
  for (const r of routed) {
    if (!onDisk.includes(r)) err(where, `routes to references/${r} which does not exist`);
  }
  for (const f of onDisk) {
    if (!routed.has(f)) warn(where, `references/${f} exists but SKILL.md never routes to it`);
  }

  const files = [skillFile, ...onDisk.map((f) => join(refDir, f))];
  for (const f of files) {
    const body = readFileSync(f, "utf8");
    lintProse(f, body);
    // Cross-links between reference files resolve to real files.
    for (const m of body.matchAll(/`([a-z0-9-]+\.md)`/g)) {
      if (!onDisk.includes(m[1]) && m[1] !== "SKILL.md") {
        err(relative(ROOT, f), `links to ${m[1]} which is not in references/`);
      }
    }
    const bytes = statSync(f).size;
    if (bytes > 2 * 1024 * 1024) err(relative(ROOT, f), "larger than 2 MB; pack builders skip it");
  }
  return { name, refs: onDisk.length };
}

function lintConfig(skillNames) {
  const file = join(ROOT, "skills.sh.json");
  if (!existsSync(file)) return warn("skills.sh.json", "absent; the repo page falls back to a flat list");
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return err("skills.sh.json", `invalid JSON: ${e.message}`);
  }
  if (cfg.notGrouped && !["top", "bottom"].includes(cfg.notGrouped)) {
    err("skills.sh.json", "notGrouped must be 'top' or 'bottom'");
  }
  if (!Array.isArray(cfg.groupings) || cfg.groupings.length < 1) {
    return err("skills.sh.json", "groupings must be a non-empty array");
  }
  if (cfg.groupings.length > 50) err("skills.sh.json", "more than 50 groupings; the rest are dropped");
  const seen = new Set();
  for (const [i, g] of cfg.groupings.entries()) {
    const at = `skills.sh.json groupings[${i}]`;
    if (!g.title || g.title.length > 120) err(at, "title must be present and under 120 chars");
    if (g.description && g.description.length > 500) err(at, "description must be under 500 chars");
    if (!Array.isArray(g.skills) || g.skills.length < 1) {
      err(at, "skills must be a non-empty array");
      continue;
    }
    for (const s of g.skills) {
      const slug = s.toLowerCase().replace(/[_\s]/g, "-");
      if (!skillNames.includes(slug)) err(at, `lists '${s}' which is not a skill in this repo`);
      if (seen.has(slug)) warn(at, `'${s}' appears in an earlier group; the first group wins`);
      seen.add(slug);
    }
  }
  for (const n of skillNames) {
    if (!seen.has(n)) warn("skills.sh.json", `'${n}' is ungrouped and lands in Other skills`);
  }
}

if (!existsSync(SKILLS_DIR)) {
  console.error("no ./skills directory");
  process.exit(1);
}
const dirs = readdirSync(SKILLS_DIR).filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory());
if (!dirs.length) err("skills/", "no skill directories found");
const results = dirs.map(lintSkill).filter(Boolean);
lintConfig(dirs);

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`error ${e}`);
console.log(
  `\n${results.length} skill(s), ${results.reduce((n, r) => n + r.refs, 0)} reference file(s), ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exit(errors.length ? 1 : 0);
