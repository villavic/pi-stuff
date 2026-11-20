/**
 * no-heredoc — block shell heredocs (`<<`) before the bash tool runs.
 *
 * Pi's `write` and `edit` tools are the supported way to change files. Heredocs
 * (`cat <<EOF`, `python3 - <<PY`, ...) are a common bypass that also defeats
 * the per-section prompt cache and tool-declaration freeze, so this extension
 * rejects any bash command whose AST contains a `heredoc_redirect` node.
 *
 * Detection uses `web-tree-sitter` + `tree-sitter-bash` (WASM, no native
 * build). The parser is initialized once, lazily, and memoized.
 */

import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REASON = [
  "BLOCKED: Shell heredocs (<<) are disabled in this environment.",
  "Do NOT use bash heredocs, inline Python/Node scripts, or shell redirections to write or modify files.",
  "Use the `write` tool for new files, or `read` the target file first and use the `edit` tool (preferring `replace` with exact anchors) to apply changes.",
].join(" ");

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | undefined;

function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const webWasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
      const bashWasm = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
      await Parser.init({ locateFile: () => webWasm });
      const parser = new Parser();
      const language = await Language.load(bashWasm);
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserPromise;
}

/** Conservative raw scan used only when the AST is unavailable or has errors. */
function rawHasHeredoc(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && !inSingle) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      return true;
    }
  }
  return false;
}

async function hasHeredoc(command: string): Promise<boolean> {
  let parser: Parser;
  try {
    parser = await getParser();
  } catch {
    return rawHasHeredoc(command);
  }
  let tree: ReturnType<Parser["parse"]> | null = null;
  try {
    tree = parser.parse(command);
    if (!tree) return rawHasHeredoc(command);
    const nodes = tree.rootNode.descendantsOfType("heredoc_redirect");
    if (nodes.length > 0) return true;
    if (tree.rootNode.hasError && rawHasHeredoc(command)) return true;
    return false;
  } catch {
    return rawHasHeredoc(command);
  } finally {
    tree?.delete();
  }
}

export default function noHeredocExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = String(
      (event.input as { command?: unknown } | undefined)?.command ?? "",
    );
    if (command === "") return undefined;
    if (await hasHeredoc(command)) {
      return { block: true, reason: REASON };
    }

    return undefined;
  });
}
export { hasHeredoc, rawHasHeredoc };
