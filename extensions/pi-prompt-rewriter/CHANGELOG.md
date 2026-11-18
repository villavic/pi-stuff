# Changelog

## 0.2.0

Refactor: install and test instructions updated to use `npm:@villavic/pi-prompt-rewriter`;
README paths corrected; per-rewrite console output suppressed.

## 0.1.0

First release. Config-driven, surgical rewriting of the prompt payload.

- Three scopes, each applied at its own Pi surface: `system_prompt`
  (`before_agent_start` → `event.systemPrompt`, returns `{ systemPrompt }`),
  `tool_description` and `tool_parameters` (`before_provider_request`,
  over `tools[].description` / `tools[].function.description` and every
  string `description` inside `input_schema` / `parameters`).
- Rules in `config.json` at the same paths other pi extensions use:
  `<agentDir>/extensions/pi-prompt-rewriter/config.json` (global) and
  `<cwd>/.pi/extensions/pi-prompt-rewriter/config.json` (project).
  `agentDir` comes from `getAgentDir()`, so `PI_CODING_AGENT_DIR` is
  honored and the isolated lab resolves inside its own root; there is no
  `os.homedir()` fallback.
- Rules compile once per load; both config files are watched, so an edit
  lands on the next request.
- Tool matching is exact, with `*` globs only: MCP tools are
  `mcp__<server>__<tool>`, as in Pi's own naming. No normalization.
- Invariants: only the text of a `description` string is rewritten — a
  rule can never drop a tool, a parameter, a schema node, or a key. A
  broken pattern is reported and skipped; an unparseable config keeps the
  previous rule set.
- Per-request stderr log of the rules that fired, and a
  `/prompt-rewriter` command showing the loaded rules and their session
  hit counts.
