#!/usr/bin/env node
// Render captured provider requests as readable YAML.
//
// The captured payload is valid JSON, but the system prompt is one JSON
// string full of \n escapes. This renders every multiline string as a
// YAML literal block scalar (|), so the prompt reads as text.
//
//   node lab/tmp/prompt-yaml.mjs [file|dir ...]
//
// Default target: .pi/prompt-capture
// Writes, next to each input:
//   <name>.yaml       the same data, block-scalar encoded
//   <name>.prompt.txt the joined instruction text, the plainest artifact
//
// Uses the `yaml` module that ships with @earendil-works/pi-coding-agent.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { stringify } from "yaml";

const OPTIONS = {
  blockQuote: "literal", // | for values containing newlines
  lineWidth: 0, // never fold lines; keep prompt wrapping exact
  indentSeq: false,
};

/** Instruction text for both wire shapes (openai-completions, anthropic). */
function instructions(payload) {
  if (typeof payload?.system === "string") return payload.system;
  if (Array.isArray(payload?.system)) {
    return payload.system.map((b) => b?.text ?? "").join("\n");
  }
  const parts = [];
  for (const message of payload?.messages ?? []) {
    if (!["system", "developer", "instructions"].includes(message?.role)) {
      continue;
    }
    if (Array.isArray(message.tools)) continue; // tool additions, not text
    const content = Array.isArray(message.content)
      ? message.content.map((p) => p?.text ?? "").join("\n")
      : String(message.content ?? "");
    parts.push(content);
  }
  return parts.join("\n\n");
}

/** Every .json file under a directory. */
function filesIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

function convert(file) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`skip, not valid JSON: ${file} (${error.message})`);
    return;
  }
  const stem = join(dirname(file), basename(file, extname(file)));
  const text = stringify(payload, OPTIONS);
  const yamlPath = `${stem}.yaml`;
  writeFileSync(yamlPath, text);

  const prompt = instructions(payload);
  const promptPath = `${stem}.prompt.txt`;
  if (prompt.trim().length > 0) writeFileSync(promptPath, prompt);

  const jsonBytes = Buffer.byteLength(readFileSync(file, "utf8"));
  const promptNote =
    prompt.trim().length > 0
      ? `, ${promptPath} (${Buffer.byteLength(prompt)} B prompt)`
      : "";
  console.log(
    `${file}\n  -> ${yamlPath} (json ${jsonBytes} B -> yaml ` +
      `${Buffer.byteLength(text)} B)${promptNote}`,
  );
}


function main(argv) {
  const files = [];
  for (const arg of argv.length > 0 ? argv : [".pi/prompt-capture"]) {
    if (!existsSync(arg)) {
      console.error(`skip, not found: ${arg}`);
      continue;
    }
    const stats = statSync(arg);
    for (const name of stats.isDirectory() ? filesIn(arg) : [arg]) files.push(name);
  }
  if (files.length === 0) {
    console.error("no json files to convert");
    process.exitCode = 1;
    return;
  }
  for (const file of files) convert(file);
}

main(process.argv.slice(2));
