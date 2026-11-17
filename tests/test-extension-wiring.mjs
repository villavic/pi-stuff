/**
 * Drive pi-prompt-rewriter's extension wiring without launching pi.
 *
 * Builds a stub ExtensionAPI that records the handlers, sets
 * PI_CODING_AGENT_DIR to a throwaway root under lab/tmp/, and runs
 * session_start, before_agent_start, before_provider_request, a real
 * hot-reload through fs.watch, and session_shutdown.
 *
 * Run: node lab/tmp/test-extension-wiring.mjs
 */

import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const ROOT = new URL("..", import.meta.url).pathname;
const SANDBOX = join(ROOT, "lab/tmp/prompt-rewriter-wiring");
const AGENT_HOME = join(SANDBOX, "agent-home");
const PROJECT = join(SANDBOX, "project");
const EXT_DIR = "extensions/pi-prompt-rewriter";

rmSync(SANDBOX, { recursive: true, force: true });
process.env.PI_CODING_AGENT_DIR = AGENT_HOME;

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(join(ROOT, "extensions/pi-prompt-rewriter/index.ts"));
const extension = mod.default;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}: ${err && err.stack}`);
  }
}

function mkdirFor(path) {
  mkdirSync(join(path, ".."), { recursive: true });
}


const globalConfig = join(AGENT_HOME, EXT_DIR, "config.json");
const projectConfig = join(PROJECT, ".pi", EXT_DIR, "config.json");
mkdirFor(globalConfig);
mkdirFor(projectConfig);

const SYSTEM_RULES = [
  {
    id: "strip-guideline",
    scope: "system_prompt",
    match: "- Always run `foo_check` before completing any task\\.\n?",
    regex: true,
    replace: "",
  },
];
const TOOL_RULES = [
  {
    id: "trim-mcp-desc",
    scope: "tool_description",
    tool: "mcp__github__*",
    match: "Get the authenticated GitHub user\\.",
    regex: true,
    replace: "Get the signed-in user.",
  },
];

writeFileSync(globalConfig, JSON.stringify({ rules: [...SYSTEM_RULES, ...TOOL_RULES] }));

const handlers = new Map();
const commands = new Map();
const notices = [];
const pi = {
  on: (event, handler) => handlers.set(event, handler),
  registerCommand: (name, def) => commands.set(name, def),
};
const ctx = {
  cwd: PROJECT,
  ui: { notify: (text, level) => notices.push({ level, text }) },
};

function payload() {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
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
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file as anchor rows.",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  };
}

async function waitFor(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

const sysPrompt = () =>
  "Header\n- Always run `foo_check` before completing any task.\nTail";

extension(pi);

await check("registered the handlers and the status command", () => {
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ["before_agent_start", "before_provider_request", "session_shutdown", "session_start"],
  );
  assert.ok(commands.has("prompt-rewriter"));
});

await check("config path honors PI_CODING_AGENT_DIR", () => {
  assert.equal(mod.globalConfigPath(), globalConfig);
  assert.equal(mod.projectConfigPath(PROJECT), projectConfig);
});

await check("session_start loads the rules and reports once", async () => {
  await handlers.get("session_start")({}, ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /rules: 2/);
  assert.equal(notices[0].level, "info");
});

await check("system_prompt rule rewrites the rendered prompt", async () => {
  const result = await handlers.get("before_agent_start")(
    { prompt: "hi", systemPrompt: sysPrompt(), systemPromptOptions: {} },
    ctx,
  );
  assert.equal(result.systemPrompt, "Header\nTail");
});

await check("tool_description rule rewrites the matching tool only", async () => {
  const result = await handlers.get("before_provider_request")(
    {
      type: "llm",
      sessionId: "s1",
      provider: "openai-completions",
      model: { id: "test-model", api: "openai-completions", provider: "test" },
      modelRequestIndex: 0,
      payload: payload(),
    },
    ctx,
  );
  const tools = result.tools;
  assert.equal(tools[0].function.description, "Get the signed-in user.");
  assert.equal(tools[1].function.description, "Read a file as anchor rows.");
  assert.equal(tools[0].function.parameters.properties.pretty.description,
    "Pretty output. Optional. Defaults to true.");
});

await check("status command lists the rules and their hit counts", async () => {
  const before = notices.length;
  await commands.get("prompt-rewriter").handler("", ctx);
  const line = notices[notices.length - 1].text;
  assert.equal(notices.length, before + 1);
  assert.match(line, /strip-guideline\s+system_prompt\s+hits=1/);
  assert.match(line, /trim-mcp-desc\s+tool_description\s+mcp__github__\*\s+hits=1/);
});

await check("a saved edit lands on the next request via fs.watch", async () => {
  const edited = [
    ...SYSTEM_RULES,
    {
      id: "trim-params",
      scope: "tool_parameters",
      tool: "mcp__github__*",
      match: "Optional\\. Defaults to .*?\\.",
      regex: true,
      replace: "",
    },
  ];
  writeFileSync(globalConfig, JSON.stringify({ rules: edited }));
  const seen = await waitFor(() => notices.some((n) => /reloaded/.test(n.text)));
  assert.ok(seen, "no reload notice from fs.watch");
  const result = await handlers.get("before_provider_request")(
    { type: "llm", sessionId: "s1", provider: "p", model: {}, modelRequestIndex: 0, payload: payload() },
    ctx,
  );
  assert.equal(result.tools[0].function.parameters.properties.pretty.description, "Pretty output. ");
  assert.equal(result.tools[0].function.description, "Get the authenticated GitHub user.");
});

await check("a project config replaces the global rules wholesale", async () => {
  writeFileSync(projectConfig, JSON.stringify({
    rules: [{ id: "project-only", scope: "system_prompt", match: "Header", replace: "Title" }],
  }));
  const seen = await waitFor(() =>
    notices.some((n) => /reloaded/.test(n.text) && /project/.test(n.text)),
  );
  assert.ok(seen, "no project reload notice");
  const sys = await handlers.get("before_agent_start")(
    { prompt: "hi", systemPrompt: sysPrompt(), systemPromptOptions: {} },
    ctx,
  );
  assert.equal(sys.systemPrompt, `Title\n- Always run \`foo_check\` before completing any task.\nTail`);
  const req = await handlers.get("before_provider_request")(
    { type: "llm", sessionId: "s1", provider: "p", model: {}, modelRequestIndex: 0, payload: payload() },
    ctx,
  );
  assert.equal(req, undefined, "global tool rule must not survive a project config");
});

await check("unparseable config keeps the previous rules and warns", async () => {
  const marker = notices.length;
  writeFileSync(projectConfig, "{ this is not json ");
  const seen = await waitFor(() =>
    notices.slice(marker).some((n) => /kept the previous rules/.test(n.text)),
  );
  assert.ok(seen, "no kept-previous-rules notice");
  const sys = await handlers.get("before_agent_start")(
    { prompt: "hi", systemPrompt: sysPrompt(), systemPromptOptions: {} },
    ctx,
  );
  assert.equal(sys.systemPrompt, `Title\n- Always run \`foo_check\` before completing any task.\nTail`);
});

await check("session_shutdown closes the watchers", async () => {
  const marker = notices.length;
  await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
  writeFileSync(globalConfig, JSON.stringify({ rules: [] }));
  const fired = await waitFor(() => notices.length > marker, 600);
  assert.equal(fired, false, "a watcher fired after shutdown");
});

await check("a missing config means no rules, not an error", async () => {
  rmSync(globalConfig);
  rmSync(projectConfig, { force: true });
  const fresh = new Map();
  extension({
    on: (event, handler) => fresh.set(event, handler),
    registerCommand: () => {},
  });
  const quiet = [];
  await fresh.get("session_start")({}, { cwd: PROJECT, ui: { notify: (t, l) => quiet.push({ t, l }) } });
  assert.match(quiet[0].t, /rules: 0/);
  const sys = await fresh.get("before_agent_start")(
    { prompt: "hi", systemPrompt: sysPrompt(), systemPromptOptions: {} },
    { cwd: PROJECT, ui: { notify: () => {} } },
  );
  assert.equal(sys, undefined);
});

console.log(failures === 0 ? "\nall wiring checks passed" : `\n${failures} wiring check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
