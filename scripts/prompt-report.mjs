#!/usr/bin/env node
// Size report for the provider payloads captured by lab/prompt-capture.ts.
//
//   node lab/tmp/prompt-report.mjs [capture-dir] [top-N]
//
// Default capture-dir: .pi/prompt-capture
// Reads req-NNN.json (the provider request body) plus the optional
// prompt-structure.json written by the /prompt-size command.
//
// Bytes are UTF-8 of the serialized JSON value. "tok~" is bytes/4,
// a heuristic: read usage.prompt_tokens from the session JSONL for
// the endpoint's real token count.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".pi/prompt-capture";
const TOP = Number(process.argv[3] ?? 12);

const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null));
const kb = (n) => `${(n / 1024).toFixed(2)}k`;
const tok = (n) => Math.round(n / 4);

function mcpServer(name) {
  const parts = name.split("__");
  return parts[0] === "mcp" && parts.length >= 2 ? `mcp:${parts[1]}` : null;
}

function toolName(tool) {
  return tool?.function?.name ?? tool?.name ?? "?";
}

/** Instruction text for both wire shapes. */
function instructions(payload) {
  const out = { text: "", bytes: 0, inlineToolBytes: 0, where: "none" };
  if (Array.isArray(payload.system)) {
    out.where = "payload.system";
    for (const block of payload.system) {
      out.text += `${block?.text ?? ""}\n`;
      out.bytes += bytes(block);
    }
    return out;
  }
  if (typeof payload.system === "string") {
    out.where = "payload.system";
    out.text = payload.system;
    out.bytes = bytes(payload.system);
    return out;
  }
  for (const message of payload.messages ?? []) {
    if (!["system", "developer", "instructions"].includes(message?.role)) {
      continue;
    }
    if (Array.isArray(message.tools)) {
      out.inlineToolBytes += bytes(message.tools);
      continue;
    }
    out.where = `messages[] role=${message.role}`;
    const content = Array.isArray(message.content)
      ? message.content.map((part) => part?.text ?? "").join("\n")
      : String(message.content ?? "");
    out.text += `${content}\n`;
    out.bytes += bytes(message);
  }
  return out;
}

/** Split Pi's prompt text into its <name> wrapped sections. */
function sections(text) {
  const lines = text.split("\n");
  const out = [];
  let head = 0;
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const openMatch = /^<([a-z][a-z0-9_-]*)>$/.exec(lines[i]);
    const closeMatch = /^<\/([a-z][a-z0-9_-]*)>$/.exec(lines[i]);
    if (!open && openMatch) {
      open = { name: openMatch[1], start: i };
    } else if (open && closeMatch?.[1] === open.name) {
      out.push({ name: open.name, bytes: Buffer.byteLength(lines.slice(open.start, i + 1).join("\n")) });
      open = null;
      head = i + 1;
    }
  }
  const rest = lines.slice(head).join("\n");
  if (Buffer.byteLength(rest.trim()) > 0) {
    out.unshift({ name: "(preamble)", bytes: Buffer.byteLength(rest.trim()) });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

function byRole(messages) {
  const map = new Map();
  for (const message of messages ?? []) {
    if (["system", "developer", "instructions"].includes(message?.role)) continue;
    const key = message?.role ?? "?";
    map.set(key, (map.get(key) ?? 0) + bytes(message));
  }
  return map;
}

function line(label, n, of) {
  const share = of ? ` (${((n / of) * 100).toFixed(1)}%)` : "";
  console.log(`  ${label.padEnd(34)} ${String(n).padStart(9)} B  ${kb(n)}${share}`);
}

function reportRequest(path) {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const total = bytes(payload);
  const instr = instructions(payload);
  const tools = payload.tools ?? [];
  const toolBytes = bytes(tools);
  const perTool = tools
    .map((tool) => ({ name: toolName(tool), bytes: bytes(tool) }))
    .sort((a, b) => b.bytes - a.bytes);
  const msgBytes = byRole(payload.messages);
  const transcriptBytes = [...msgBytes.values()].reduce((a, b) => a + b, 0);

  console.log(`\n=== ${path}  model=${payload.model ?? "?"} ===`);
  line("request body total", total, total);
  line(`system prompt (${instr.where})`, instr.bytes, total);
  line(`tools array (${tools.length} tools)`, toolBytes, total);
  if (instr.inlineToolBytes) line("tools in system messages", instr.inlineToolBytes, total);
  line("transcript (messages)", transcriptBytes, total);
  console.log(`  ~tokens ${tok(total)}  (bytes/4 heuristic)`);

  console.log("  system prompt sections:");
  for (const s of sections(instr.text).slice(0, TOP)) {
    line(`  <${s.name}>`, s.bytes, instr.bytes);
  }

  const servers = new Map();
  for (const t of perTool) {
    const key = mcpServer(t.name) ?? "core/extension";
    servers.set(key, (servers.get(key) ?? 0) + t.bytes);
  }
  console.log("  tool declarations by source:");
  for (const [name, n] of [...servers].sort((a, b) => b[1] - a[1])) {
    line(`  ${name}`, n, toolBytes);
  }
  console.log(`  largest tool declarations (top ${TOP} of ${perTool.length}):`);
  for (const t of perTool.slice(0, TOP)) line(`  ${t.name}`, t.bytes, toolBytes);

  if (msgBytes.size > 0) {
    console.log("  transcript by role:");
    for (const [role, n] of [...msgBytes].sort((a, b) => b[1] - a[1])) {
      line(`  ${role}`, n, transcriptBytes);
    }
  }
  return { file: path, total };
}

function reportStructure(path) {
  const s = JSON.parse(readFileSync(path, "utf8"));
  console.log(`\n=== ${path}  (Pi prompt inputs, no request) ===`);
  console.log(`  model ${s.model}  cwd ${s.cwd}`);
  line("system prompt (Pi string)", s.systemPromptBytes, s.systemPromptBytes);
  console.log("  sections (wrapped by Pi as <name> blocks):");
  for (const sec of [...s.sections].sort((a, b) => b.bytes - a.bytes)) {
    line(`  <${sec.name}>`, sec.bytes, s.systemPromptBytes);
  }
  const total = s.declarationBytesBySource.reduce((a, e) => a + e.bytes, 0);
  console.log(`  active tools ${s.activeTools.length}  declarations ${total} B`);
  for (const e of s.declarationBytesBySource) line(`  source ${e.source}`, e.bytes, total);
  const perTool = s.toolDeclarations
    .map((t) => ({
      name: t.name,
      bytes: t.descriptionBytes + t.schemaBytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);
  console.log(`  largest declarations (top ${TOP} of ${perTool.length}):`);
  for (const t of perTool.slice(0, TOP)) line(`  ${t.name}`, t.bytes, total);
}

if (!existsSync(dir)) {
  console.error(`no capture directory: ${dir}`);
  process.exit(1);
}
const reqs = readdirSync(dir)
  .filter((f) => /^req-\d+\.json$/.test(f))
  .sort()
  .map((f) => join(dir, f));
if (reqs.length === 0) console.log(`(no req-NNN.json in ${dir})`);
const summaries = reqs.map(reportRequest);
const structure = join(dir, "prompt-structure.json");
if (existsSync(structure)) reportStructure(structure);
if (summaries.length > 0) {
  console.log("\n=== requests ===");
  for (const s of summaries) line(s.file, s.total, summaries[0].total);
  console.log(`  first request is the full prompt: ${kb(summaries[0].total)}`);
}
