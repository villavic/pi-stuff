# pi-stuff

Personal Pi coding-agent extensions.

## CI

[![CI](https://github.com/villavic/pi-stuff/actions/workflows/ci.yml/badge.svg)](https://github.com/villavic/pi-stuff/actions/workflows/ci.yml)
[![Publish](https://github.com/villavic/pi-stuff/actions/workflows/publish.yml/badge.svg)](https://github.com/villavic/pi-stuff/actions/workflows/publish.yml)

## Extensions

- **kilo-resolved-model** — Shows which model the `kilo-auto`/`free` router actually selected, and surfaces it in the pi-bar status bar.
- **pi-prompt-rewriter** — Rewrites system prompts and tool descriptions/payloads using configurable rules, including project-scoped rule sets.
- **prompt-capture** — Captures outgoing LLM requests (system prompt, tools, transcript) to `.pi/prompt-capture/` for inspection and analysis. Implementation: `extensions/prompt-capture/index.ts`.
- **no-heredoc** — Blocks shell heredocs (`<<`) in `bash` tool calls via a tree-sitter-bash AST check. Implementation: `extensions/no-heredoc/index.ts`.

## Install

```bash
pi install npm:@villavic/pi-prompt-rewriter
```

## Test

```bash
pi -e ./extensions/pi-prompt-rewriter/index.ts
node tests/test-rewriter.mjs
```