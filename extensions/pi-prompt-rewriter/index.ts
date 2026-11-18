/**
 * pi-prompt-rewriter — surgical text rewriting of the prompt payload.
 *
 * The workflow: capture what Pi really sends (see lab/prompt-capture.ts),
 * copy the unwanted text out of it, wrap it in one
 * `{ scope, tool?, match, replace }` entry in `config.json`, save, and the
 * next request carries the replacement. No code changes per rule.
 *
 * Config lives in this extension's own directory, at the same paths:
 *   global   <agentDir>/extensions/pi-prompt-rewriter/config.json
 *   project  <cwd>/.pi/extensions/pi-prompt-rewriter/config.json
 * `agentDir` comes from `getAgentDir()`, which honors
 * `PI_CODING_AGENT_DIR`, so the isolated lab resolves inside its own root.
 * A project config replaces the global rule list wholesale. A missing file
 * is silent; a malformed one warns and keeps the last good rules. Both files
 * are watched, so an edit lands on the next request.
 *
 * Three scopes, each aimed at one Pi surface:
 *
 *   system_prompt     before_agent_start: reads `event.systemPrompt` (the
 *                     rendered prompt) and returns `{ systemPrompt }`.
 *   tool_description  before_provider_request: `tools[].description`
 *                     (Anthropic messages, OpenAI Responses) and
 *                     `tools[].function.description` (OpenAI chat).
 *   tool_parameters   before_provider_request: every `"description"` string
 *                     inside `input_schema` / `parameters`, walked
 *                     recursively.
 *
 * Invariant: a rule can only rewrite the text of a `description` string. It
 * never deletes a key, an entry, a parameter, or a tool, and a tool scope
 * never touches the system prompt.
 *
 * Tool names are matched exactly as they appear in the payload. MCP tools
 * are `mcp__<server>__<tool>` (docs/mcp.md), so `*` globs are
 * `mcp__github__*`, `mcp__*`.
 *
 * Cost of a system_prompt rule: returning `systemPrompt` replaces the prompt
 * for every turn and bypasses the per-section diff Pi uses for prompt
 * caching, so each such turn pays a full prompt-cache miss. Tool-scope rules
 * have the same effect on the tool declarations. Keep the set small.
 */

import {
  existsSync,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "pi-prompt-rewriter";
const SCOPES = ["system_prompt", "tool_description", "tool_parameters"] as const;
const TOOL_SCHEMA_KEYS = ["input_schema", "parameters"] as const;
const RELOAD_DEBOUNCE_MS = 150;

type Scope = (typeof SCOPES)[number];

export interface Rule {
  id: string;
  scope: Scope;
  /** Exact tool name, or a glob with `*`. Absent means every tool. */
  tool?: string;
  match: string;
  regex: boolean;
  flags: string;
  replace: string;
}

export interface CompiledRule extends Rule {
  re: RegExp | undefined;
  toolRe: RegExp | undefined;
  error: string | undefined;
}

export interface ParseResult {
  rules: Rule[];
  issues: string[];
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is Scope {
  return (SCOPES as readonly unknown[]).includes(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact match, with `*` as the only wildcard. */
function globToRegExp(pattern: string): RegExp {
  let body = "";
  for (const char of pattern) {
    body += char === "*" ? ".*" : escapeRegExp(char);
  }
  return new RegExp(`^${body}$`);
}

/** Drop unknown fields and report each rule that has no usable shape. */
export function parseConfig(raw: unknown): ParseResult {
  const rules: Rule[] = [];
  const issues: string[] = [];
  if (!isObj(raw)) {
    return { rules, issues: ["config is not a JSON object"] };
  }
  const list = raw.rules;
  if (list === undefined) return { rules, issues };
  if (!Array.isArray(list)) {
    return { rules, issues: ["`rules` is not an array"] };
  }

  list.forEach((entry: unknown, index: number) => {
    const label = `rule ${index}`;
    if (!isObj(entry)) {
      issues.push(`${label}: not an object`);
      return;
    }
    const id = typeof entry.id === "string" ? entry.id : `rule-${index}`;
    if (typeof entry.match !== "string" || entry.match === "") {
      issues.push(`${id}: \`match\` must be a non-empty string`);
      return;
    }
    if (!isScope(entry.scope)) {
      issues.push(`${id}: scope must be one of ${SCOPES.join(", ")}`);
      return;
    }
    if (entry.replace !== undefined && typeof entry.replace !== "string") {
      issues.push(`${id}: \`replace\` must be a string`);
      return;
    }
    if (entry.tool !== undefined && typeof entry.tool !== "string") {
      issues.push(`${id}: \`tool\` must be a string`);
      return;
    }
    if (entry.flags !== undefined && typeof entry.flags !== "string") {
      issues.push(`${id}: \`flags\` must be a string`);
      return;
    }
    rules.push({
      id,
      scope: entry.scope,
      tool: typeof entry.tool === "string" ? entry.tool : undefined,
      match: entry.match,
      regex: entry.regex === true,
      flags: typeof entry.flags === "string" ? entry.flags : "g",
      replace: typeof entry.replace === "string" ? entry.replace : "",
    });
  });
  return { rules, issues };
}

/**
 * Compile once. `regex: false` escapes `match` so it is taken literally.
 * `g` is always on: a rule replaces every occurrence, not the first one.
 */
export function compileRules(rules: Rule[]): {
  compiled: CompiledRule[];
  issues: string[];
} {
  const compiled: CompiledRule[] = [];
  const issues: string[] = [];
  for (const rule of rules) {
    const flags = rule.flags.includes("g") ? rule.flags : `${rule.flags}g`;
    let re: RegExp | undefined;
    let error: string | undefined;
    try {
      re = rule.regex ? new RegExp(rule.match, flags) : new RegExp(escapeRegExp(rule.match), "g");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      issues.push(`${rule.id}: bad pattern (${error})`);
    }
    compiled.push({
      ...rule,
      re,
      toolRe: rule.tool === undefined ? undefined : globToRegExp(rule.tool),
      error,
    });
  }
  return { compiled, issues };
}

/** Replace every match. `$` in `replace` is literal text. */
function applyRule(
  text: string,
  rule: CompiledRule,
): { text: string; hits: number } {
  if (!rule.re) return { text, hits: 0 };
  const matches = text.match(rule.re);
  const hits = matches ? matches.length : 0;
  if (hits === 0) return { text, hits: 0 };
  return { text: text.replace(rule.re, () => rule.replace), hits };
}

function ruleAppliesToTool(rule: CompiledRule, name: string | undefined): boolean {
  if (rule.toolRe === undefined) return true;
  return name !== undefined && rule.toolRe.test(name);
}

function toolName(entry: Obj): string | undefined {
  const fn = isObj(entry.function) ? entry.function : undefined;
  const sources = fn ? [fn, entry] : [entry];
  for (const source of sources) {
    if (typeof source.name === "string") return source.name;
  }
  return undefined;
}

/** The object holding this tool's `description`: `function` for OpenAI chat. */
function descriptionHolder(entry: Obj): Obj {
  return isObj(entry.function) ? entry.function : entry;
}

function schemaNodes(entry: Obj): Obj[] {
  const nodes: Obj[] = [];
  const fn = isObj(entry.function) ? entry.function : undefined;
  for (const source of fn ? [fn, entry] : [entry]) {
    for (const key of TOOL_SCHEMA_KEYS) {
      const schema = source[key];
      if (isObj(schema)) nodes.push(schema);
    }
  }
  return nodes;
}

/** Rewrite every string under a `description` key, in place, at any depth. */
function rewriteSchemaDescriptions(
  node: unknown,
  rules: CompiledRule[],
  counts: Map<string, number>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteSchemaDescriptions(item, rules, counts);
    return;
  }
  if (!isObj(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") {
      let text = value;
      for (const rule of rules) {
        const result = applyRule(text, rule);
        text = result.text;
        if (result.hits > 0) {
          counts.set(rule.id, (counts.get(rule.id) ?? 0) + result.hits);
        }
      }
      node[key] = text;
      continue;
    }
    rewriteSchemaDescriptions(value, rules, counts);
  }
}

/**
 * Rewrite tool prose in a provider payload. Accepts the shapes in the wild:
 * Anthropic messages (`description`, `input_schema`), OpenAI Responses
 * (`description`, `parameters`), OpenAI chat (`function.description`,
 * `function.parameters`). Returns the same payload object when nothing
 * matched, so a rule set for another provider costs nothing.
 */
export function rewriteToolPayload(
  payload: unknown,
  rules: CompiledRule[],
): { payload: unknown; changed: boolean; counts: Map<string, number> } {
  const none = { payload, changed: false, counts: new Map<string, number>() };
  if (!isObj(payload) || !Array.isArray(payload.tools)) return none;

  const scoped = rules.filter((rule) => !rule.error && rule.re);
  const descRules = scoped.filter((rule) => rule.scope === "tool_description");
  const paramRules = scoped.filter((rule) => rule.scope === "tool_parameters");
  if (descRules.length === 0 && paramRules.length === 0) return none;

  let tools: unknown[];
  try {
    tools = structuredClone(payload.tools);
  } catch {
    // Payloads carry provider objects that structuredClone refuses; leave
    // the request alone rather than risk mutating the live payload.
    return none;
  }

  const counts = new Map<string, number>();
  for (const entry of tools) {
    if (!isObj(entry)) continue;
    const name = toolName(entry);

    const holder = descriptionHolder(entry);
    if (typeof holder.description === "string") {
      let text = holder.description;
      for (const rule of descRules) {
        if (!ruleAppliesToTool(rule, name)) continue;
        const result = applyRule(text, rule);
        text = result.text;
        if (result.hits > 0) {
          counts.set(rule.id, (counts.get(rule.id) ?? 0) + result.hits);
        }
      }
      holder.description = text;
    }

    const toolParamRules = paramRules.filter((rule) => ruleAppliesToTool(rule, name));
    if (toolParamRules.length > 0) {
      for (const schema of schemaNodes(entry)) {
        rewriteSchemaDescriptions(schema, toolParamRules, counts);
      }
    }
  }

  if (counts.size === 0) return none;
  return { payload: { ...payload, tools }, changed: true, counts };
}

export function rewriteSystemPrompt(
  systemPrompt: string,
  rules: CompiledRule[],
): { systemPrompt: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  let text = systemPrompt;
  for (const rule of rules) {
    if (rule.scope !== "system_prompt" || rule.error || !rule.re) continue;
    const result = applyRule(text, rule);
    text = result.text;
    if (result.hits > 0) counts.set(rule.id, (counts.get(rule.id) ?? 0) + result.hits);
  }
  return { systemPrompt: text, counts };
}

export function globalConfigPath(): string {
  return join(getAgentDir(), "extensions", EXTENSION_ID, "config.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

interface Layer {
  path: string;
  present: boolean;
  rules: Rule[];
  issues: string[];
}

function readLayer(path: string): Layer {
  const issues: string[] = [];
  if (!existsSync(path)) return { path, present: false, rules: [], issues };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      path,
      present: true,
      rules: [],
      issues: [`${path}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const { rules, issues: shapeIssues } = parseConfig(parsed);
  return { path, present: true, rules, issues: shapeIssues };
}

export default function promptRewriterExtension(pi: ExtensionAPI) {
  let compiled: CompiledRule[] = [];
  let watchers: FSWatcher[] = [];
  let totalIssues: string[] = [];
  let source = "";
  const lifetime = new Map<string, number>();

  function report(counts: Map<string, number>): void {
    for (const [id, hits] of counts) {
      lifetime.set(id, (lifetime.get(id) ?? 0) + hits);
      // suppressed: report only via /prompt-rewriter command
    }
  }

  function summary(): string {
    const n = compiled.length;
    const broken = compiled.filter((rule) => rule.error).length;
    const parts = [`rules: ${n}`];
    if (broken > 0) parts.push(`${broken} broken`);
    if (totalIssues.length > 0) parts.push(`issues: ${totalIssues.length}`);
    return parts.join(", ");
  }

  function load(cwd: string, why: string, notify: (text: string, level: "info" | "error") => void): void {
    const globalLayer = readLayer(globalConfigPath());
    const projectLayer = readLayer(projectConfigPath(cwd));
    // A present project file replaces the global list; an absent one inherits.
    const active = projectLayer.present ? projectLayer : globalLayer;
    const { compiled: next, issues: compileIssues } = compileRules(active.rules);
    const issues = [...globalLayer.issues, ...projectLayer.issues, ...compileIssues];

    // Nothing usable came out of this read: a file that will not parse, or
    // rules whose patterns all fail to compile. Keep the last good set so a
    // typo in the file cannot leave the session with no rules.
    const unusable = active.rules.length === 0 && active.issues.length > 0;
    const allBroken = next.length === 0 && active.rules.length > 0;
    if (issues.length > 0 && (unusable || allBroken) && compiled.length > 0) {
      totalIssues = issues;
      notify(
        `${why}: kept the previous rules from ${source}. ${issues[0] ?? "config invalid"}`,
        "error",
      );
      return;
    }

    compiled = next;
    source = active.path;
    totalIssues = issues;
    for (const issue of issues) console.error(`[prompt-rewriter] ${issue}`);
    notify(
      `prompt-rewriter (${why}): ${active.path} — ${summary()}`,
      issues.length > 0 ? "error" : "info",
    );
  }

  function watchConfig(cwd: string, ctx: ExtensionContext): void {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    const paths = [globalConfigPath(), projectConfigPath(cwd)];
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const path of paths) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, (_event, changed) => {
          if (!changed || basename(changed) !== basename(path)) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            load(cwd, "reloaded", (text, level) => ctx.ui.notify(text, level));
          }, RELOAD_DEBOUNCE_MS);
        });
        watchers.push(watcher);
      } catch (err) {
        console.error(
          `[prompt-rewriter] cannot watch ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    load(ctx.cwd, "loaded", (text, level) => ctx.ui.notify(text, level));
    watchConfig(ctx.cwd, ctx);
  });

  pi.on("session_shutdown", async () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  });

  pi.on("before_agent_start", async (event) => {
    if (compiled.every((rule) => rule.scope !== "system_prompt")) return undefined;
    const { systemPrompt, counts } = rewriteSystemPrompt(
      event.systemPrompt,
      compiled,
    );
    report(counts);
    if (counts.size === 0) return undefined;
    return { systemPrompt };
  });

  pi.on("before_provider_request", async (event) => {
    const result = rewriteToolPayload(event.payload, compiled);
    report(result.counts);
    return result.changed ? result.payload : undefined;
  });

  pi.registerCommand("prompt-rewriter", {
    description: "Show the active rewrite rules and their hit counts",
    handler: async (_args, ctx) => {
      const lines = compiled.map((rule) => {
        const hits = lifetime.get(rule.id) ?? 0;
        const scope = rule.scope.padEnd(16);
        const tool = rule.tool ? ` ${rule.tool}` : "";
        const broken = rule.error ? "  BROKEN" : "";
        return `${rule.id}  ${scope}${tool}  hits=${hits}${broken}`;
      });
      const head = `${summary()}${totalIssues.length > 0 ? ` — first issue: ${totalIssues[0]}` : ""}`;
      ctx.ui.notify([head, ...lines].join("\n"), "info");
    },
  });
}
