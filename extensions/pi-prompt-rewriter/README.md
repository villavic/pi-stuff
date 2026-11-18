# pi-prompt-rewriter

Surgical rewriting of the prompt payload, driven by rules in a config file.

## The intent

Inspect the rendered prompt payload, copy the undesired text out of it,
wrap it in a `{ "scope": ..., "match": ..., "replace": ... }` entry in
`config.json`, save the file, and the extension performs the
replacement on the next request.

The point is **surgical tuning of the whole prompt** — the system prompt,
the tool descriptions, the parameter descriptions — not shrinking its
size. Rules target text you have seen in a capture, so each edit is
deliberate and reviewable.

## config.json

| Scope | Path |
|---|---|
| global | `<agentDir>/extensions/pi-prompt-rewriter/config.json` |
| project | `<cwd>/.pi/extensions/pi-prompt-rewriter/config.json` |

`agentDir` comes from Pi's `getAgentDir()`, which honors
`PI_CODING_AGENT_DIR` — so the isolated lab resolves inside its own root.
There is no `os.homedir()` fallback: a home fallback points at the real
`~` from inside `./lab/`, which is the wrong agent dir.

When the project file exists its `rules` **replace** the global list;
when it is absent, the global list applies. Both files are watched, so an
edit lands on the next request — rules compile once per load.

Example:

```json
{
  "rules": [
    {
      "id": "trim-verbose-mcp-tool",
      "scope": "tool_description",
      "tool": "mcp__github__search_issues",
      "match": "Searches GitHub issues across repositories using advanced qualifiers[\\s\\S]*?Returns up to 100 results\\.",
      "regex": true,
      "replace": "Search GitHub issues by query."
    },
    {
      "id": "shorten-param-docs",
      "scope": "tool_parameters",
      "tool": "mcp__github__*",
      "match": "Optional\\. Defaults to .*?\\.",
      "regex": true,
      "replace": ""
    },
    {
      "id": "strip-extension-guideline",
      "scope": "system_prompt",
      "match": "- Always run `foo_check` before completing any task\\.\n?",
      "regex": true,
      "replace": ""
    }
  ]
}
```

## Scopes

| `scope` in `config.json` | Where it applies | What it catches |
|---|---|---|
| `system_prompt` | `context_with_system` — rewrites each string section on `SystemMessage.sections` (and `content` when present) without setting `forceSystemPrompt` | The preamble, `docs`, `rules` (`promptGuidelines` / `toolGuidelines`), `tools` (`toolSnippets`), `project_context` (`AGENTS.md`), `skills`, and custom extension sections. |
| `tool_description` | `before_provider_request` — rewrites `tool.description` (Anthropic messages, OpenAI Responses), `tool.function.description` (OpenAI chat), and Anthropic `tool_addition` blocks | The `description` of any built-in, extension, or MCP tool, whatever the provider. |
| `tool_parameters` | `before_provider_request` — recursively walks `input_schema` / `parameters` JSON schema nodes and rewrites every string `description` field | Verbose per-argument instructions and multi-line examples inside tool parameter schemas. |

## Rule fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `id` | recommended | `rule-<index>` | Names the rule in logs and in `/prompt-rewriter`. |
| `scope` | yes | — | One of the three scopes above. |
| `tool` | for tool scopes | unset = every tool | Exact tool name, or a glob with `*`. |
| `match` | yes | — | Text to find. |
| `regex` | no | `false` | `true` treats `match` as a regular expression; `false` treats it as literal text. |
| `flags` | no | `"g"` | Regex flags; `g` is always added, so every occurrence is replaced. |
| `replace` | no | `""` | Replacement text. `$` is literal — `$&` does not re-insert the match. |

Names are matched **exactly as they appear in the payload**: MCP tools
are `mcp__<server>__<tool>` (Pi docs, `docs/mcp.md`), so use
`mcp__github__get_me`, `mcp__github__*`, `mcp__*`. No normalization and
no underscore collapsing — a single-underscore spelling matches nothing.
Capture a payload to see the exact names, and note that they depend on a
server's `exposure`: `direct` servers declare `mcp__<server>__<tool>`
entries, while a namespace proxy appears as `mcp__<server>`.

## Guarantees

- A rule can only rewrite the **text** of a `description` string. It
  never deletes a key, an array entry, a parameter, a schema node, or a
  tool. An emptied description stays as `""`, so the tool still declares
  itself.
- Tool scopes never touch the system prompt; the system scope never
  touches tools.
- A rule whose pattern fails to compile is reported and skipped; a config
  file that is not valid JSON is reported and the previous rule set is
  kept, so a typo cannot leave you with no rules.
- Payloads that cannot be cloned are left alone rather than mutated.
- When no rule matches, the payload and the prompt are returned untouched
  — a rule set written for another provider costs nothing.

## Seeing the effect

`/prompt-rewriter` prints the loaded rules, the config path in use, and
the per-rule hit count for the session. To see the result in the payload
itself, capture it with `extensions/prompt-capture/index.ts` and re-run
the rules against the capture: `node tests/test-rewriter.mjs`.

## Prompt caching

`system_prompt` rules rewrite `SystemMessage.sections.*` in
`context_with_system` instead of returning `{ systemPrompt }` from
`before_agent_start`. Because `forceSystemPrompt` is never set, Pi keeps
its structured section diff (`diffSystemPromptSections`) and
mid-conversation section updates intact.

On Turn 1 of a session, rewritten section strings and rewritten tool
schemas are snapshotted in session maps. Turn 2+ reuses those frozen
snapshots in O(1) without re-evaluating rules or rebuilding schemas, and
returns a reference-preserving no-op when nothing matches — yielding
`cacheWrite` once on Turn 1 and `cacheRead` on Turn 2+ (until rules are
edited or reloaded).

## Install

```bash
pi install npm:@villavic/pi-prompt-rewriter
```

## Test

```bash
pi -e ./extensions/pi-prompt-rewriter/index.ts
node tests/test-rewriter.mjs
```

Config lives in `~/.pi/agent/extensions/pi-prompt-rewriter/config.json`
(global) or `.pi/extensions/pi-prompt-rewriter/config.json` (project).
Reload a changed file with `/reload`, or just save it — the watcher picks
it up.
