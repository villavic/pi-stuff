#!/usr/bin/env node
// Assert a converted <name>.yaml round-trips to the same data as its
// source JSON, so the literal block scalars lose nothing.
//
//   node lab/tmp/prompt-yaml-check.mjs [dir]     default .pi/prompt-capture

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const dir = process.argv[2] ?? ".pi/prompt-capture";
let checked = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const yamlPath = join(dir, `${name.slice(0, -5)}.yaml`);
  let source;
  try {
    source = JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch (error) {
    console.log(`skip (json unreadable): ${name} ${error.message}`);
    continue;
  }
  let round;
  try {
    round = parse(readFileSync(yamlPath, "utf8"));
  } catch (error) {
    console.log(`FAIL (yaml parse): ${name} ${error.message}`);
    process.exitCode = 1;
    continue;
  }
  const a = JSON.stringify(source);
  const b = JSON.stringify(round);
  if (a === b) {
    checked += 1;
    console.log(`ok: ${name} === ${name.slice(0, -5)}.yaml (${a.length} B)`);
  } else {
    process.exitCode = 1;
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
    console.log(
      `FAIL (bytes differ at ${i} of ${a.length}/${b.length}):\n` +
        `  json: ${JSON.stringify(a.slice(i, i + 120))}\n` +
        `  yaml: ${JSON.stringify(b.slice(i, i + 120))}`,
    );
  }
}
console.log(`${checked} file(s) round-trip identical`);
