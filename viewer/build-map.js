#!/usr/bin/env node
// Copies lot-map's drawing code into viewer/map/ as plain browser modules, for the popped-out map.
// lot-map (https://github.com/alexeyw/lot-map, MIT) draws its map with pure functions that take a
// board and return an SVG string; only these files are needed, and none of them touch Claude Code.
// Node's own type stripping turns them into JS, so there is no build dependency.
//
//   git clone --depth 1 https://github.com/alexeyw/lot-map /some/dir
//   node viewer/build-map.js /some/dir
//
// Rerun it to pick up a new lot-map version.

const fs = require("fs");
const path = require("path");
const { stripTypeScriptTypes } = require("node:module");

const FILES = ["setup", "palette", "classify", "draw", "feed", "text"];

const src = process.argv[2];
if (!src || !fs.existsSync(path.join(src, "hooks", "draw.ts"))) {
  console.error("usage: node viewer/build-map.js <lot-map checkout>");
  process.exit(1);
}
const out = path.join(__dirname, "map");
fs.mkdirSync(out, { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(src, ".claude-plugin", "plugin.json"), "utf8")).version;
for (const name of FILES) {
  const js = stripTypeScriptTypes(fs.readFileSync(path.join(src, "hooks", `${name}.ts`), "utf8"))
    // Browsers need the extension on a relative import.
    .replace(/from '\.\/(\w+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(out, `${name}.js`), `// From lot-map ${version} hooks/${name}.ts, by viewer/build-map.js. Do not edit.\n${js}`);
}
fs.copyFileSync(path.join(src, "LICENSE"), path.join(out, "LICENSE"));
console.log(`lot-map ${version}: ${FILES.length} files -> ${out}`);
