/**
 * Pre-publish gate: refuse to publish a bundle that would not work once installed.
 *
 * `npm publish` happily ships a stale `client.js`, a missing locale key, a
 * `link:`-only assumption, or a test that never ran. This script is what runs
 * before the tarball leaves the machine, and it checks the things that are
 * expensive to discover afterwards — from a stranger's machine, where nobody
 * can debug it.
 *
 * Run: node scripts/prepublish.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const problems = [];
const fail = (message) => problems.push(message);

const pkg = JSON.parse(read("package.json"));

// ── package metadata a marketplace reader needs ──────────────────────────
if (pkg.private === true) fail("package.json is private; npm would refuse to publish it");
if (typeof pkg.description !== "string" || pkg.description.trim() === "") fail("package.json needs a description");
if (pkg.license !== "MIT") fail("license should stay MIT for an open-source plugin");
for (const field of ["repository", "homepage", "bugs"]) {
  if (pkg[field] === undefined) fail(`package.json is missing "${field}"`);
}
if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail("package.json needs a files whitelist");
if (pkg.dsh === undefined || pkg.dsh.bundle === undefined) fail('package.json needs a "dsh.bundle" entry');
if (pkg.dsh?.bundle?.patch === undefined || !existsSync(join(root, pkg.dsh.bundle.patch))) {
  fail("the dsh.bundle.patch file must exist");
}

// ── the files a user actually loads must be in the tarball ───────────────
for (const file of ["index.js", "client.js", "cordis.patch.yml", "icon.svg", "locale/zh.json", "locale/en.json", "LICENSE", "README.md"]) {
  if (!existsSync(join(root, file))) fail(`missing required file: ${file}`);
}

// ── no absolute path to the author's machine may ship ────────────────────
for (const file of ["index.js", "client.js", "cordis.patch.yml", "README.md"]) {
  if (!existsSync(join(root, file))) continue;
  const text = read(file);
  if (/\/Users\/[a-z0-9._-]+\//iu.test(text)) fail(`${file} contains an absolute path from a developer machine`);
}

// ── locale parity, mirrored from build.mjs so this gate stands alone ─────
const zh = JSON.parse(read("locale/zh.json"));
const en = JSON.parse(read("locale/en.json"));
for (const key of Object.keys(zh)) if (!(key in en)) fail(`locale/en.json is missing "${key}"`);
for (const key of Object.keys(en)) if (!(key in zh)) fail(`locale/zh.json is missing "${key}"`);
for (const [name, dict] of [["zh", zh], ["en", en]]) {
  for (const [key, value] of Object.entries(dict)) {
    // `meta` and `panel` are display metadata read by the Plugin Manager: `meta`
    // is an object, everything else is copy the panel renders.
    if (key === "meta") {
      if (value === null || typeof value !== "object") fail(`locale/${name}.json "meta" must be an object`);
      else for (const field of ["title", "description"]) {
        if (typeof value[field] !== "string" || value[field].trim() === "") fail(`locale/${name}.json meta.${field} must be a non-empty string`);
      }
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") fail(`locale/${name}.json "${key}" must be a non-empty string`);
  }
}

// ── the dispatched client bundle must match its source ──────────────────
try {
  execFileSync(process.execPath, [join(root, "scripts", "build.mjs"), "--check"], { stdio: "pipe" });
} catch {
  fail("client.js is stale or invalid; run `npm run build` before publishing");
}

// ── node syntax of everything that loads on install ─────────────────────
for (const file of ["index.js", "client.js"]) {
  try {
    execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
  } catch {
    fail(`${file} does not parse`);
  }
}

if (problems.length > 0) {
  console.error("prepublish check failed:\n" + problems.map((line) => `  - ${line}`).join("\n"));
  process.exit(1);
}
console.log(`prepublish check passed — ${pkg.name}@${pkg.version} is ready to publish`);