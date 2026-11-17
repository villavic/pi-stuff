/**
 * Exercise pi-prompt-rewriter rules against a real captured payload.
 *
 * Loads extensions/pi-prompt-rewriter/index.ts with jiti, so no pi process
 * is needed. Reads the payload of the newest capture in
 * .pi/prompt-capture/, applies rule sets, and asserts the invariants:
 * nothing is deleted, the original payload is not mutated, and each scope
 * fires only where it should. Prints rule ids and hit counts only, so the
 * payload content (which can hold server config prose) never reaches the
 * terminal.
 *
 * Run: node lab/tmp/test-rewriter.mjs [path/to/req-xxx.json]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const ROOT = new URL("..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(join(ROOT, "extensions/pi-prompt-rewriter/index.ts"));
const {
  compileRules,
  parseConfig,
  rewriteSystemPrompt,
  rewriteToolPayload,
} = mod;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}: ${err && err.message}`);
  }
}

function newestCapture() {
  const dir = join(ROOT, ".pi/prompt-capture");
  const files = readdirSync(dir)
    .filter((f) => /^req-\d+\.json$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no captures in ${dir}`);
  return join(dir, files[files.length - 1]);
}

const capturePath = process.argv[2] ?? newestCapture();
const payload = JSON.parse(readFileSync(capturePath, "utf8"));
const toolNames = payload.tools.map((t) => t.function?.name ?? t.name);
const nested = payload.tools.filter((t) => t.function).length;
console.log(`capture: ${capturePath}`);
console.log(`model: ${payload.model}  tools: ${toolNames.length}  nested function shape: ${nested}`);
console.log(`tools with a description: ${payload.tools.filter((t) => typeof (t.function?.description ?? t.description) === "string").length}`);

const anthropic = {
  tools: [
    {
      name: "web_search",
      description: "Search the web. Results are ranked by relevance.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query. Optional filters may be added." },
          limit: { type: "number", description: "Max results. Optional. Defaults to 10." },
        },
        required: ["query"],
      },
    },
    {
      name: "mcp__github__search_issues",
      description:
        "Searches GitHub issues across repositories using advanced qualifiers.\nReturns up to 100 results.",
      input_schema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Query text. Optional. Defaults to open issues." },
        },
        required: ["q"],
      },
    },
  ],
};

const openaiChat = {
  tools: [
    {
      type: "function",
      function: {
        name: "mcp__github__get_me",
        description: "Get the authenticated GitHub user.",
        parameters: {
          type: "object",
          properties: {
            pretty: { type: "boolean", description: "Pretty output. Optional. Defaults to true." },
          },
        },
      },
    },
  ],
};

function compile(rules) {
  return compileRules(parseConfig({ rules }).rules).compiled;
}

function keyShape(tools) {
  return JSON.stringify(
    tools.map((t) => {
      const src = t.function ?? t;
      const schema = src.input_schema ?? src.parameters;
      const props = schema && schema.properties
        ? Object.keys(schema.properties).sort()
        : [];
      return {
        keys: Object.keys(t).sort(),
        name: src.name,
        hasDescription: typeof src.description === "string",
        propKeys: props,
        propKeySets: schema && schema.properties
          ? Object.keys(schema.properties)
              .sort()
              .map((k) => Object.keys(schema.properties[k]).sort())
          : [],
        required: schema?.required ?? null,
      };
    }),
  );
}

const anthShape = keyShape(anthropic.tools);
const anthSnapshot = JSON.stringify(anthropic);
const openaiShape = keyShape(openaiChat.tools);

check("capture payload has tools and is rewritable in principle", () => {
  assert.ok(toolNames.length > 0);
  const rules = compile([{ id: "all", scope: "tool_description", match: "e", replace: "E" }]);
  const r = rewriteToolPayload(payload, rules);
  assert.equal(r.changed, true);
  assert.equal(r.payload.tools.length, payload.tools.length);
});

check("capture payload keeps its key shape under a blanket rule", () => {
  const rules = compile([{ id: "all", scope: "tool_description", match: "e", replace: "E" }]);
  const before = keyShape(payload.tools);
  const r = rewriteToolPayload(payload, rules);
  assert.equal(keyShape(r.payload.tools), before);
});

check("tool_description fires on the Anthropic shape", () => {
  const rules = compile([
    {
      id: "short-desc",
      scope: "tool_description",
      tool: "web_search",
      match: "Results are ranked by relevance.",
      replace: "",
    },
  ]);
  const r = rewriteToolPayload(anthropic, rules);
  assert.equal(r.changed, true);
  assert.equal(r.counts.get("short-desc"), 1);
  assert.equal(r.payload.tools[0].description, "Search the web. ");
  assert.equal(r.payload.tools[1].description, anthropic.tools[1].description);
  assert.equal(r.payload.tools.length, 2);
});

check("tool_parameters fires inside input_schema and empties to empty string", () => {
  const rules = compile([
    {
      id: "param-docs",
      scope: "tool_parameters",
      tool: "web_search",
      match: "Optional\\. Defaults to .*?\\.",
      regex: true,
      replace: "",
    },
    {
      id: "param-docs-all",
      scope: "tool_parameters",
      match: "Optional filters may be added.",
      replace: "",
    },
  ]);
  const r = rewriteToolPayload(anthropic, rules);
  const props = r.payload.tools[0].input_schema.properties;
  assert.equal(props.limit.description, "Max results. ");
  assert.equal(props.query.description, "The query. ");
  assert.equal(r.counts.get("param-docs"), 1);
  assert.equal(r.counts.get("param-docs-all"), 1);
  assert.equal(keyShape(r.payload.tools), anthShape);
});

check("tool_parameters fires on the OpenAI chat function.parameters shape", () => {
  const rules = compile([
    {
      id: "chat-params",
      scope: "tool_parameters",
      tool: "mcp__github__*",
      match: "Pretty output\\. Optional\\. Defaults to true\\.",
      regex: true,
      replace: "",
    },
  ]);
  const r = rewriteToolPayload(openaiChat, rules);
  assert.equal(r.changed, true);
  assert.equal(r.payload.tools[0].function.parameters.properties.pretty.description, "");
  assert.equal(keyShape(r.payload.tools), openaiShape);
});

check("tool_description fires on the OpenAI chat function.description", () => {
  const rules = compile([
    {
      id: "chat-desc",
      scope: "tool_description",
      tool: "mcp__github__get_me",
      match: "Get the authenticated GitHub user.",
      replace: "Get the signed-in user.",
    },
  ]);
  const r = rewriteToolPayload(openaiChat, rules);
  assert.equal(r.payload.tools[0].function.description, "Get the signed-in user.");
});

check("tool filter excludes non-matching tools and honors mcp__* globs", () => {
  const rules = compile([
    { id: "one", scope: "tool_description", tool: "mcp__github__get_me", match: "GitHub", replace: "GH" },
    { id: "two", scope: "tool_description", tool: "mcp__*", match: "GitHub", replace: "X" },
    { id: "three", scope: "tool_description", tool: "web_search", match: "GitHub", replace: "Y" },
  ]);
  const r = rewriteToolPayload(openaiChat, rules);
  assert.equal(r.payload.tools[0].function.description, "Get the authenticated GH user.");
  assert.equal(r.counts.get("two"), undefined);
  assert.equal(r.counts.get("three"), undefined);
});

check("literal mode matches regex characters as text", () => {
  const rules = compile([
    { id: "lit", scope: "tool_description", tool: "web_search", match: "ranked by relevance.", replace: "ranked." },
  ]);
  const r = rewriteToolPayload(anthropic, rules);
  assert.equal(r.counts.get("lit"), 1);
  assert.ok(r.payload.tools[0].description.endsWith("ranked."));
});

check("replace is literal, $& does not re-insert the match", () => {
  const rules = compile([
    { id: "dollar", scope: "tool_description", tool: "web_search", match: "Search", replace: "$&X" },
  ]);
  const r = rewriteToolPayload(anthropic, rules);
  assert.ok(r.payload.tools[0].description.startsWith("$&X the web."));
});

check("g is always on, every occurrence is replaced", () => {
  const src = {
    tools: [
      {
        name: "rep",
        description: "ab ab ab",
        parameters: {
          type: "object",
          properties: {
            a: { type: "string", description: "ab ab" },
            b: { type: "string", description: "ab" },
          },
        },
      },
    ],
  };
  const rules = compile([{ id: "g", scope: "tool_description", match: "ab", flags: "", replace: "z" }]);
  const r = rewriteToolPayload(src, rules);
  assert.equal(r.payload.tools[0].description, "z z z");
  assert.equal(r.counts.get("g"), 3);
});

check("a rule that matches nothing leaves the payload object untouched", () => {
  const rules = compile([
    { id: "nope", scope: "tool_description", tool: "web_search", match: "not present at all", replace: "x" },
  ]);
  const r = rewriteToolPayload(anthropic, rules);
  assert.equal(r.changed, false);
  assert.equal(r.payload, anthropic);
});

check("the input payload is never mutated", () => {
  const rules = compile([
    { id: "wipe", scope: "tool_description", match: "[\\s\\S]+", regex: true, replace: "" },
    { id: "wipe-params", scope: "tool_parameters", match: "[\\s\\S]+", regex: true, replace: "" },
  ]);
  const r = rewriteToolPayload(anthropic, rules);
  assert.equal(JSON.stringify(anthropic), anthSnapshot);
  assert.equal(r.payload.tools[0].description, "");
  assert.ok("description" in r.payload.tools[1].input_schema.properties.q);
  assert.equal(r.payload.tools[1].input_schema.properties.q.description, "");
  assert.equal(keyShape(r.payload.tools), anthShape);
});

check("a payload that cannot be cloned is left alone", () => {
  const withFn = {
    tools: [{ name: "web_search", description: "Search the web.", hook: () => 1 }],
  };
  const rules = compile([{ id: "any", scope: "tool_description", match: "Search", replace: "X" }]);
  const r = rewriteToolPayload(withFn, rules);
  assert.equal(r.changed, false);
  assert.equal(r.payload, withFn);
  assert.equal(withFn.tools[0].description, "Search the web.");
});

check("a broken pattern is reported and skipped, siblings still fire", () => {
  const { compiled, issues } = compileRules(
    parseConfig({
      rules: [
        { id: "broken", scope: "tool_description", tool: "web_search", match: "([unclosed", regex: true, replace: "x" },
        { id: "fine", scope: "tool_description", tool: "web_search", match: "Search", replace: "Find" },
      ],
    }).rules,
  );
  assert.equal(issues.length, 1);
  assert.ok(issues[0].startsWith("broken:"));
  assert.equal(compiled.find((r) => r.id === "broken").error !== undefined, true);
  const r = rewriteToolPayload(anthropic, compiled);
  assert.equal(r.payload.tools[0].description.startsWith("Find the web."), true);
});

check("parseConfig drops unusable entries and reports each one", () => {
  const { rules, issues } = parseConfig({
    rules: [
      { id: "ok", scope: "tool_parameters", match: "a", replace: "b" },
      { id: "bad-scope", scope: "tool_result", match: "a" },
      { id: "no-match", scope: "system_prompt" },
      "not an object",
      { id: "defaults", scope: "system_prompt", match: "z" },
    ],
  });
  assert.deepEqual(rules.map((r) => r.id), ["ok", "defaults"]);
  assert.equal(issues.length, 3);
  assert.equal(rules[1].regex, false);
  assert.equal(rules[1].flags, "g");
  assert.equal(rules[1].replace, "");
  assert.equal(rules[1].tool, undefined);
});

check("system_prompt scope rewrites the prompt text only", () => {
  const rules = compile([
    { id: "sys", scope: "system_prompt", match: "- Always run `foo_check` before completing any task\\.\n?", regex: true, replace: "" },
    { id: "tool-only", scope: "tool_description", match: "Search", replace: "X" },
  ]);
  const prompt = "Header\n- Always run `foo_check` before completing any task.\nTail";
  const s = rewriteSystemPrompt(prompt, rules);
  assert.equal(s.systemPrompt, "Header\nTail");
  assert.equal(s.counts.get("sys"), 1);
  assert.equal(s.counts.get("tool-only"), undefined);
  const toolsOnlyFromSystemScope = rewriteToolPayload(anthropic, compile([
    { id: "sys", scope: "system_prompt", match: "Search", replace: "X" },
  ]));
  assert.equal(toolsOnlyFromSystemScope.payload, anthropic);
});

check("tool scopes never reach the system prompt, system scope never reaches tools", () => {
  const s = rewriteSystemPrompt("Search the web.", compile([
    { id: "t", scope: "tool_description", tool: "web_search", match: "Search", replace: "X" },
  ]));
  assert.equal(s.systemPrompt, "Search the web.");
  assert.equal(s.counts.size, 0);
});

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
