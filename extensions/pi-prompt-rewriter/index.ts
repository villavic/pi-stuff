/**
 * pi-prompt-rewriter — surgical text rewriting of the prompt payload.
 *
 * The workflow: capture what Pi really sends (extensions/prompt-capture/index.ts),
 * copy the unwanted text out of it, wrap it in one
 * `{ scope, tool?, match, replace }` entry in `config.json`, save, and the
 * next request carries the replacement. No code changes per rule.
 *
 * Config lives in this extension's own directory, at the same paths:
 *   global   <agentDir>/extensions/pi-prompt-rewriter/config.json
 *   project  <cwd>/.pi/extensions/pi-prompt-rewriter/config.json
 * `agentDir` comes from `getAgentDir()`, which honors `PI_CODING_AGENT_DIR`.
 * A project config replaces the global rule list wholesale. A missing file
 * is silent; a malformed one warns and keeps the last good rules. Both files
 * are watched, so an edit lands on the next request.
 *
 * Three scopes, each aimed at one Pi surface:
 *
 *   system_prompt     context_with_system: rewrites each string section on
 *                     `SystemMessage.sections` (and `content` when present)
 *                     without setting `forceSystemPrompt`, preserving Pi's
 *                     per-section diff and mid-conversation section updates.
 *   tool_description  before_provider_request: `tools[].description`
 *                     (Anthropic messages, OpenAI Responses),
 *                     `tools[].function.description` (OpenAI chat), and
 *                     Anthropic `tool_addition` definitions.
 *   tool_parameters   before_provider_request: every `"description"` string
 *                     inside `input_schema` / `parameters`, walked
 *                     recursively.
 *
 * Prompt-cache behavior: Turn 1 evaluates active rules once and snapshots the
 * rewritten section strings and rewritten tool schemas in session maps; Turn 2+
 * reuses the frozen snapshots in O(1) with reference-preserving no-ops when
 * nothing matches, yielding `cacheWrite` on Turn 1 and `cacheRead` on Turn 2+.
 *
 * Invariant: a rule can only rewrite prose strings. Tool rules never delete a
 * key, an entry, a parameter, or a tool, and a tool scope never touches the
 * system prompt.
 *
 * Tool names are matched exactly as they appear in the payload. MCP tools
 * are `mcp__<server>__<tool>` (docs/mcp.md), so `*` globs are
 * `mcp__github__*`, `mcp__*`.
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

export interface CachedTextRewrite {
  text: string;
  changed: boolean;
}

export interface CachedToolRewrite {
  changed: boolean;
  topDescription?: string;
  topInputSchema?: unknown;
  topParameters?: unknown;
  fnDescription?: string;
  fnInputSchema?: unknown;
  fnParameters?: unknown;
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

function mergeCounts(
  target: Map<string, number>,
  source: Map<string, number>,
): void {
  for (const [id, hits] of source) {
    target.set(id, (target.get(id) ?? 0) + hits);
  }
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
      re = rule.regex
        ? new RegExp(rule.match, flags)
        : new RegExp(escapeRegExp(rule.match), "g");
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

function ruleAppliesToTool(
  rule: CompiledRule,
  name: string | undefined,
): boolean {
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
 * Shallow-wrap a live tool entry with frozen Turn-1 description/schema values,
 * preserving exact property order and per-request fields like `cache_control`.
 */
function applyCachedTool(entry: Obj, cached: CachedToolRewrite): Obj {
  const next: Obj = { ...entry };
  if (isObj(entry.function)) {
    const nextFn: Obj = { ...entry.function };
    if (cached.fnDescription !== undefined) {
      nextFn.description = cached.fnDescription;
    }
    if (cached.fnInputSchema !== undefined) {
      nextFn.input_schema = cached.fnInputSchema;
    }
    if (cached.fnParameters !== undefined) {
      nextFn.parameters = cached.fnParameters;
    }
    next.function = nextFn;
  } else if (cached.topDescription !== undefined) {
    next.description = cached.topDescription;
  }
  if (cached.topInputSchema !== undefined) {
    next.input_schema = cached.topInputSchema;
  }
  if (cached.topParameters !== undefined) {
    next.parameters = cached.topParameters;
  }
  return next;
}

function rewriteSingleTool(
  entry: unknown,
  descRules: CompiledRule[],
  paramRules: CompiledRule[],
  memo: Map<string, CachedToolRewrite> | undefined,
  counts: Map<string, number>,
): { entry: unknown; changed: boolean } | null {
  if (!isObj(entry)) return { entry, changed: false };
  const name = toolName(entry);
  const myDesc = descRules.filter((rule) => ruleAppliesToTool(rule, name));
  const myParam = paramRules.filter((rule) => ruleAppliesToTool(rule, name));
  if (myDesc.length === 0 && myParam.length === 0) {
    return { entry, changed: false };
  }

  const fn = isObj(entry.function) ? entry.function : undefined;
  const holder = fn ?? entry;
  let cacheKey: string | undefined;
  if (memo !== undefined) {
    const rawDesc =
      typeof holder.description === "string" ? holder.description : "\0";
    let schemaSig = "";
    if (myParam.length > 0) {
      try {
        schemaSig = JSON.stringify([
          entry.input_schema,
          entry.parameters,
          fn?.input_schema,
          fn?.parameters,
        ]);
      } catch {
        return null;
      }
    }
    cacheKey = `${fn ? 1 : 0}\0${name ?? ""}\0${rawDesc}\0${schemaSig}`;
    const hit = memo.get(cacheKey);
    if (hit !== undefined) {
      return hit.changed
        ? { entry: applyCachedTool(entry, hit), changed: true }
        : { entry, changed: false };
    }
  }

  let cloned: Obj;
  try {
    cloned = structuredClone(entry);
  } catch {
    return null;
  }

  const entryCounts = new Map<string, number>();
  const clonedHolder = descriptionHolder(cloned);
  if (typeof clonedHolder.description === "string") {
    let text = clonedHolder.description;
    for (const rule of myDesc) {
      const result = applyRule(text, rule);
      text = result.text;
      if (result.hits > 0) {
        entryCounts.set(rule.id, (entryCounts.get(rule.id) ?? 0) + result.hits);
      }
    }
    clonedHolder.description = text;
  }

  if (myParam.length > 0) {
    for (const schema of schemaNodes(cloned)) {
      rewriteSchemaDescriptions(schema, myParam, entryCounts);
    }
  }

  if (entryCounts.size === 0) {
    memo?.set(cacheKey!, { changed: false });
    return { entry, changed: false };
  }

  mergeCounts(counts, entryCounts);
  const clonedFn = isObj(cloned.function) ? cloned.function : undefined;
  const snapshot: CachedToolRewrite = {
    changed: true,
    topDescription:
      !clonedFn && typeof cloned.description === "string"
        ? cloned.description
        : undefined,
    topInputSchema: isObj(cloned.input_schema)
      ? cloned.input_schema
      : undefined,
    topParameters: isObj(cloned.parameters) ? cloned.parameters : undefined,
    fnDescription:
      clonedFn && typeof clonedFn.description === "string"
        ? clonedFn.description
        : undefined,
    fnInputSchema:
      clonedFn && isObj(clonedFn.input_schema)
        ? clonedFn.input_schema
        : undefined,
    fnParameters:
      clonedFn && isObj(clonedFn.parameters) ? clonedFn.parameters : undefined,
  };
  if (memo !== undefined && cacheKey !== undefined) {
    memo.set(cacheKey, snapshot);
  }
  return { entry: applyCachedTool(entry, snapshot), changed: true };
}

/**
 * Rewrite tool prose in a provider payload. Accepts the shapes in the wild:
 * Anthropic messages (`description`, `input_schema` and `tool_addition`
 * blocks), OpenAI Responses (`description`, `parameters`), and OpenAI chat
 * (`function.description`, `function.parameters`). Returns the exact input
 * payload reference when nothing matched, and reuses Turn-1 frozen schema
 * snapshots when `memo` is supplied.
 */
export function rewriteToolPayload(
  payload: unknown,
  rules: CompiledRule[],
  memo?: Map<string, CachedToolRewrite>,
): { payload: unknown; changed: boolean; counts: Map<string, number> } {
  const none = { payload, changed: false, counts: new Map<string, number>() };
  if (!isObj(payload)) return none;

  const scoped = rules.filter((rule) => !rule.error && rule.re);
  const descRules = scoped.filter((rule) => rule.scope === "tool_description");
  const paramRules = scoped.filter((rule) => rule.scope === "tool_parameters");
  if (descRules.length === 0 && paramRules.length === 0) return none;

  const hasTools = Array.isArray(payload.tools);
  const hasMessages = Array.isArray(payload.messages);
  if (!hasTools && !hasMessages) return none;

  const counts = new Map<string, number>();
  let toolsChanged = false;
  let nextTools: unknown[] | undefined;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools;
    const out = new Array<unknown>(tools.length);
    for (let i = 0; i < tools.length; i++) {
      const res = rewriteSingleTool(
        tools[i],
        descRules,
        paramRules,
        memo,
        counts,
      );
      if (res === null) return none;
      out[i] = res.entry;
      if (res.changed) toolsChanged = true;
    }
    if (toolsChanged) nextTools = out;
  }

  let messagesChanged = false;
  let nextMessages: unknown[] | undefined;
  if (Array.isArray(payload.messages)) {
    const msgs = payload.messages;
    let outMsgs: unknown[] | undefined;
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (!isObj(msg) || !Array.isArray(msg.content)) continue;
      let blocksChanged = false;
      let outBlocks: unknown[] | undefined;
      const blocks = msg.content;
      for (let j = 0; j < blocks.length; j++) {
        const block = blocks[j];
        if (
          !isObj(block) ||
          block.type !== "tool_addition" ||
          !isObj(block.tool) ||
          !isObj(block.tool.definition)
        ) {
          continue;
        }
        const res = rewriteSingleTool(
          block.tool.definition,
          descRules,
          paramRules,
          memo,
          counts,
        );
        if (res === null) return none;
        if (res.changed) {
          if (!outBlocks) outBlocks = blocks.slice();
          outBlocks[j] = {
            ...block,
            tool: { ...block.tool, definition: res.entry },
          };
          blocksChanged = true;
        }
      }
      if (blocksChanged && outBlocks) {
        if (!outMsgs) outMsgs = msgs.slice();
        outMsgs[i] = { ...msg, content: outBlocks };
        messagesChanged = true;
      }
    }
    if (messagesChanged) nextMessages = outMsgs;
  }

  if (!toolsChanged && !messagesChanged) return none;
  const nextPayload: Obj = { ...payload };
  if (toolsChanged && nextTools) nextPayload.tools = nextTools;
  if (messagesChanged && nextMessages) nextPayload.messages = nextMessages;
  return { payload: nextPayload, changed: true, counts };
}

export function rewriteSystemPrompt(
  systemPrompt: string,
  rules: CompiledRule[],
  memo?: Map<string, CachedTextRewrite>,
): { systemPrompt: string; changed: boolean; counts: Map<string, number> } {
  const cached = memo?.get(systemPrompt);
  if (cached !== undefined) {
    return {
      systemPrompt: cached.text,
      changed: cached.changed,
      counts: new Map<string, number>(),
    };
  }
  const counts = new Map<string, number>();
  let text = systemPrompt;
  for (const rule of rules) {
    if (rule.scope !== "system_prompt" || rule.error || !rule.re) continue;
    const result = applyRule(text, rule);
    text = result.text;
    if (result.hits > 0) {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + result.hits);
    }
  }
  const changed = counts.size > 0;
  memo?.set(systemPrompt, { text, changed });
  return { systemPrompt: text, changed, counts };
}

/**
 * Rewrite `role === "system"` messages across a transcript without mutating
 * input objects. Operates per section on `msg.sections` (preserving section
 * keys and `null` tombstones) and on non-empty `msg.content`, returning the
 * exact input `messages` reference when nothing matched.
 */
export function rewriteSystemMessages<T>(
  messages: T[],
  rules: CompiledRule[],
  memo?: Map<string, CachedTextRewrite>,
): { messages: T[]; changed: boolean; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const active = rules.filter(
    (rule) => rule.scope === "system_prompt" && !rule.error && rule.re,
  );
  if (active.length === 0) {
    return { messages, changed: false, counts };
  }

  let anyChanged = false;
  let out: T[] | undefined;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isObj(msg) || msg.role !== "system") continue;

    let sectionsChanged = false;
    let nextSections: Record<string, unknown> | undefined;
    if (isObj(msg.sections)) {
      const entries = Object.entries(msg.sections);
      const candidate: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        if (typeof value !== "string" || value.length === 0) {
          candidate[key] = value;
          continue;
        }
        const res = rewriteSystemPrompt(value, active, memo);
        mergeCounts(counts, res.counts);
        candidate[key] = res.systemPrompt;
        if (res.changed) sectionsChanged = true;
      }
      if (sectionsChanged) nextSections = candidate;
    }

    let contentChanged = false;
    let nextContent: unknown;
    if (typeof msg.content === "string" && msg.content.length > 0) {
      const res = rewriteSystemPrompt(msg.content, active, memo);
      mergeCounts(counts, res.counts);
      if (res.changed) {
        contentChanged = true;
        nextContent = res.systemPrompt;
      }
    } else if (Array.isArray(msg.content)) {
      let blocksOut: unknown[] | undefined;
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (
          !isObj(block) ||
          block.type !== "text" ||
          typeof block.text !== "string" ||
          block.text.length === 0
        ) {
          continue;
        }
        const res = rewriteSystemPrompt(block.text, active, memo);
        mergeCounts(counts, res.counts);
        if (res.changed) {
          if (!blocksOut) blocksOut = msg.content.slice();
          blocksOut[j] = { ...block, text: res.systemPrompt };
          contentChanged = true;
        }
      }
      if (contentChanged) nextContent = blocksOut;
    }

    if (sectionsChanged || contentChanged) {
      if (!out) out = messages.slice();
      const updated: Obj = { ...msg };
      if (sectionsChanged && nextSections) updated.sections = nextSections;
      if (contentChanged) updated.content = nextContent;
      out[i] = updated as T;
      anyChanged = true;
    }
  }

  if (!anyChanged || !out) {
    return { messages, changed: false, counts };
  }
  return { messages: out, changed: true, counts };
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
  let rulesSignature = "";
  let watchers: FSWatcher[] = [];
  let totalIssues: string[] = [];
  let source = "";
  const lifetime = new Map<string, number>();
  const sectionMemo = new Map<string, CachedTextRewrite>();
  const toolMemo = new Map<string, CachedToolRewrite>();

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

  function load(
    cwd: string,
    why: string,
    notify: (text: string, level: "info" | "error") => void,
  ): void {
    const globalLayer = readLayer(globalConfigPath());
    const projectLayer = readLayer(projectConfigPath(cwd));
    // A present project file replaces the global list; an absent one inherits.
    const active = projectLayer.present ? projectLayer : globalLayer;
    const { compiled: next, issues: compileIssues } = compileRules(active.rules);
    const issues = [
      ...globalLayer.issues,
      ...projectLayer.issues,
      ...compileIssues,
    ];

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

    const nextSignature = JSON.stringify(active.rules);
    if (nextSignature !== rulesSignature) {
      rulesSignature = nextSignature;
      sectionMemo.clear();
      toolMemo.clear();
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
    sectionMemo.clear();
    toolMemo.clear();
    rulesSignature = "";
    load(ctx.cwd, "loaded", (text, level) => ctx.ui.notify(text, level));
    watchConfig(ctx.cwd, ctx);
  });

  pi.on("session_shutdown", async () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  });

  pi.on("context_with_system", async (event) => {
    if (compiled.every((rule) => rule.scope !== "system_prompt")) {
      return undefined;
    }
    const result = rewriteSystemMessages(
      event.messages,
      compiled,
      sectionMemo,
    );
    report(result.counts);
    return result.changed ? { messages: result.messages } : undefined;
  });

  pi.on("before_provider_request", async (event) => {
    const result = rewriteToolPayload(event.payload, compiled, toolMemo);
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
