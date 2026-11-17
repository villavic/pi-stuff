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
| `system_prompt` | `before_agent_start` — reads `event.systemPrompt` (the rendered prompt) and returns `{ systemPrompt }` | The AGENTS.md system prompt, skill descriptions, `toolSnippets`, and each extension's `promptGuidelines` — anything in the rendered text. |
| `tool_description` | `before_provider_request` — normalizes `tool.description` (Anthropic messages, OpenAI Responses) and `tool.function.description` (OpenAI chat) | The `description` of any built-in, extension, or MCP tool, whatever the provider. |
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

Each request logs one line per rule that fired, to stderr:

```
[prompt-rewriter] shorten-param-docs: 14 replacement(s)
```

`/prompt-rewriter` prints the loaded rules, the config path in use, and
the per-rule hit count for the session. Start-up and every reload report a
one-line summary. To see the result in the payload itself, capture it with
`lab/prompt-capture.ts` and re-run the rules against the capture:
`node lab/tmp/test-rewriter.mjs`.

## Cost

Returning `systemPrompt` from `before_agent_start` replaces the whole
prompt for a turn and bypasses the per-section diff Pi uses for prompt
caching, so a `system_prompt` rule costs a full prompt-cache miss on
every turn. Tool-scope rules have the same effect on the tool
declarations. Keep the rule set small and specific.

## Install and test

```bash
pi -e ./extensions/pi-prompt-rewriter/index.ts   # single file, this repo
node lab/tmp/test-rewriter.mjs                   # rules vs. a captured payload
npm run typecheck                                # from the repo root
```

Config lives in `~/.pi/agent/extensions/pi-prompt-rewriter/config.json`
(global) or `.pi/extensions/pi-prompt-rewriter/config.json` (project).
Reload a changed file with `/reload`, or just save it — the watcher picks
it up.
