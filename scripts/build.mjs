#!/usr/bin/env node
/**
 * Build `client.js` from `client.src.js`.
 *
 * The browser half cannot import JSON, so the two locale dictionaries are
 * compiled inline. `locale/zh.json` and `locale/en.json` stay the single
 * source of truth for both the runtime dictionaries and the Plugin Manager's
 * display metadata (`meta`, `panel`), which the shell reads itself and which
 * therefore never enter the compiled dictionaries.
 *
 * The script then fails loudly on exactly the mistakes a plain-JS browser
 * bundle cannot catch at load time:
 *
 *   1. an injected factory that throws takes the whole shell down, so the only
 *      `require()` targets allowed are the two platform seeds;
 *   2. the two locales must carry an identical key set (a missing English key
 *      would otherwise surface as a raw key in the UI);
 *   3. every placeholder must be a non-empty name, and no string may be blank;
 *   4. `__DICT_*__` placeholders must all be consumed, and no TODO/FIXME
 *      marker may ship.
 *
 * Keys are NOT cross-checked against `t("...")` call sites: the panel reaches
 * its locale through data-driven key families (`kind.cash`, `month.2026-11`,
 * classification labels…) that a source scan would either miss or have to
 * whitelist at length, and the offline client suite already proves every copy
 * the user sees. Static checking stops where it would produce noise instead of
 * signal.
 *
 * Usage: node scripts/build.mjs [--check]
 *   --check  verify the committed client.js is up to date without writing it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

/** Keys the shell owns; read from the locale file but never compiled in. */
const DISPLAY_ONLY_KEYS = new Set(["meta", "panel"]);

/** Both platform seeds the browser half is allowed to require. */
const ALLOWED_REQUIRES = new Set(["react", "react/jsx-runtime"]);

const problems = [];

/** Parse one locale file, reporting a syntax error instead of throwing. */
const loadLocale = (language) => {
  try {
    const parsed = JSON.parse(read(`locale/${language}.json`));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`locale/${language}.json must be a JSON object`);
      return null;
    }
    return parsed;
  } catch (error) {
    problems.push(`locale/${language}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

const zh = loadLocale("zh");
const en = loadLocale("en");
if (zh === null || en === null) {
  fail("locale files could not be parsed");
}

/** Runtime dictionaries: everything except the display-only keys. */
const runtimeOf = (locale) => {
  const dictionary = {};
  for (const [key, value] of Object.entries(locale)) {
    if (!DISPLAY_ONLY_KEYS.has(key)) dictionary[key] = value;
  }
  return dictionary;
};
const zhDict = runtimeOf(zh);
const enDict = runtimeOf(en);

// ── key-set parity ────────────────────────────────────────────────────────
const zhKeys = Object.keys(zhDict).sort();
const enKeys = Object.keys(enDict).sort();
for (const key of zhKeys) if (!(key in enDict)) problems.push(`locale/en.json is missing "${key}"`);
for (const key of enKeys) if (!(key in zhDict)) problems.push(`locale/zh.json is missing "${key}"`);

// ── value shape ───────────────────────────────────────────────────────────
for (const [language, dictionary] of [
  ["zh", zhDict],
  ["en", enDict]
]) {
  for (const [key, value] of Object.entries(dictionary)) {
    if (typeof value !== "string") {
      problems.push(`locale/${language}.json "${key}" must be a string`);
      continue;
    }
    if (value.trim() === "") {
      problems.push(`locale/${language}.json "${key}" must not be blank`);
      continue;
    }
    for (const match of value.matchAll(/\{(\w*)\}/gu)) {
      if (match[1] === "") problems.push(`locale/${language}.json "${key}" has an empty placeholder`);
    }
  }
}

// ── display metadata the Plugin Manager needs ─────────────────────────────
for (const [language, locale] of [
  ["zh", zh],
  ["en", en]
]) {
  if (locale.meta === null || typeof locale.meta !== "object") {
    problems.push(`locale/${language}.json is missing "meta"`);
  } else {
    for (const field of ["title", "description"]) {
      const value = locale.meta[field];
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`locale/${language}.json meta.${field} must be a non-empty string`);
      }
    }
  }
  if (typeof locale.panel !== "string" || locale.panel.trim() === "") {
    problems.push(`locale/${language}.json "panel" must be a non-empty string`);
  }
}

if (problems.length > 0) fail("locale check failed", problems);

// ── compile ───────────────────────────────────────────────────────────────
/** Render one dictionary as an object literal, one key per line. */
const literal = (dictionary) => {
  const lines = Object.entries(dictionary).map(([key, value]) => `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(",\n")}\n    }`;
};

const source = read("client.src.js");
if (!source.includes("__DICT_ZH__") || !source.includes("__DICT_EN__")) {
  fail("client.src.js must declare both __DICT_ZH__ and __DICT_EN__ placeholders");
}

const output = source
  .replace("__DICT_ZH__", literal(zhDict))
  .replace("__DICT_EN__", literal(enDict));

const after = [];
if (output.includes("__DICT_")) after.push("client.src.js still contains an unknown __DICT_*__ placeholder");
if (/\b(?:TODO|FIXME)\b/u.test(output)) after.push("client.js still contains a TODO/FIXME marker");
if (after.length > 0) fail("compile check failed", after);

// ── the browser half may only reach for the platform seeds ────────────────
for (const match of output.matchAll(/\brequire\(\s*"([^"]+)"\s*\)/gu)) {
  if (!ALLOWED_REQUIRES.has(match[1])) {
    fail("compile check failed", [`client.js requires "${match[1]}"; only ${[...ALLOWED_REQUIRES].join(" and ")} are allowed`]);
  }
}

// ── write or verify ───────────────────────────────────────────────────────
const target = join(root, "client.js");
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (current !== output) {
    fail("client.js is stale; run `node scripts/build.mjs`");
  }
  console.log(`client.js is up to date (${String(Object.keys(zhDict).length)} keys per locale)`);
} else {
  writeFileSync(target, output);
  console.log(
    `wrote client.js — ${String(Object.keys(zhDict).length)} keys per locale, ${String(output.split("\n").length)} lines`
  );
}

/**
 * Report problems and exit non-zero.
 * @param {string} headline one-line summary.
 * @param {string[]} [details] the individual findings.
 * @returns {never} never returns.
 */
function fail(headline, details = []) {
  console.error(headline);
  for (const line of details) console.error(`  - ${line}`);
  process.exit(1);
}