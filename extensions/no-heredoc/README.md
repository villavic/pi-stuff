# no-heredoc

Blocks shell heredocs (`<<`) in `bash` tool calls before execution.

## The intent

Heredocs (`cat <<EOF`, `python3 - <<PY`, `git commit -m "$(cat <<EOF ...)"`)
are a common way to bypass Pi's `write`/`edit` tools and to inject inline
scripts. They also defeat the per-section prompt cache and tool-declaration
freeze that `npm:@villavic/pi-prompt-rewriter` relies on. This extension rejects any bash
command whose AST contains a `heredoc_redirect` node, steering the model
toward `write` and `edit` instead.

Detection uses `web-tree-sitter` + `tree-sitter-bash` (WASM, no native
build) and parses the full command, so heredocs are caught anywhere:
pipelines, subshells, command substitution, and compound statements.

## What it blocks / allows

- **Blocked:** `heredoc_redirect` nodes — `<<EOF`, `<<'EOF'`, `<<"EOF"`,
  `<<-EOF`, `<<PY`, etc.
- **Allowed:** here-strings (`<<< "single line"`), `<<` inside quoted
  strings (`echo "a << b"`), and bit-shift operators in arithmetic
  (`echo $((1 << 4))`).

## Install

```bash
pi install npm:@villavic/no-heredoc
```

## Test

```bash
pi -e ./extensions/no-heredoc/index.ts
node tests/test-no-heredoc.mjs
```
