import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createJiti } from "jiti";

const ROOT = new URL("..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(join(ROOT, "extensions/no-heredoc/index.ts"));

const { hasHeredoc, rawHasHeredoc } = mod;

// 1. Verify WASM artifacts actually exist on disk (prevents silent catch-fallback masking!)
const req = createRequire(join(ROOT, "extensions/no-heredoc/index.ts"));
assert.doesNotThrow(
  () => req.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
  "tree-sitter-bash.wasm failed to resolve — AST parser is silently falling back to regex!"
);

// 2. AST vs. Fallback proof:
// rawHasHeredoc CANNOT distinguish arithmetic bit-shift `((1 << 4))` from a heredoc,
// so if WASM AST parsing is truly active, `hasHeredoc` MUST return false here.
assert.equal(rawHasHeredoc("echo $((1 << 4))"), true, "Sanity check: raw scanner sees <<");
assert.equal(
  await hasHeredoc("echo $((1 << 4))"),
  false,
  "WASM AST parser did not run! Arithmetic bit-shift was falsely flagged as a heredoc."
);

// 3. Core Heredoc & Benign Cases
const cases = [
  // Should BLOCK (true)
  { name: "standard EOF heredoc", cmd: "cat << 'EOF' > foo.txt\nhello\nEOF", expected: true },
  { name: "indented tab heredoc (<<-)", cmd: "cat <<-EOF\n\thello\n\tEOF", expected: true },
  { name: "python stdin heredoc", cmd: "python3 - << 'PY'\nprint(1)\nPY", expected: true },
  { name: "command-substitution heredoc", cmd: 'git commit -m "$(cat <<EOF\nmsg\nEOF\n)"', expected: true },
  { name: "pipeline heredoc", cmd: "cat <<EOF | grep foo\nfoo\nEOF", expected: true },

  // Should ALLOW (false)
  { name: "here-string (<<<)", cmd: 'grep "foo" <<< "foobar"', expected: false },
  { name: "double-quoted <<", cmd: 'echo "a << b"', expected: false },
  { name: "single-quoted <<", cmd: "echo 'a << b'", expected: false },
  { name: "arithmetic bit-shift", cmd: "echo $((1 << 4))", expected: false },
  { name: "double-quoted << with syntax error (fallback test)", cmd: 'echo "a << b" && ((', expected: false },
];

let failures = 0;
for (const { name, cmd, expected } of cases) {
  const got = await hasHeredoc(cmd);
  if (got !== expected) {
    failures += 1;
    console.error(`FAIL [${name}]: expected ${expected}, got ${got}`);
  } else {
    console.log(`PASS [${name}]`);
  }
}

// 4. Verify Pi Extension tool_call hook wiring
let registeredHandler;
mod.default({
  on(eventName, fn) {
    if (eventName === "tool_call") registeredHandler = fn;
  },
});

assert.ok(registeredHandler, "Extension did not register a tool_call listener");
const blockedRes = await registeredHandler({
  toolName: "bash",
  input: { command: "cat <<EOF > x.txt\nhi\nEOF" },
});
assert.equal(blockedRes?.block, true, "tool_call did not block heredoc");
assert.ok(blockedRes?.reason?.includes("edit"), "rejection reason should steer toward edit tool");

const allowedRes = await registeredHandler({
  toolName: "read",
  input: { path: "foo.txt" },
});
assert.equal(allowedRes, undefined, "non-bash tool calls must pass through untouched");

// 5. WASM memory leak stress check (catches missing tree.delete())
for (let i = 0; i < 500; i++) {
  await hasHeredoc(`echo "iteration ${i}" && ls -la`);
}
console.log("PASS [500-iteration WASM memory stress check]");

assert.equal(failures, 0, `${failures} check(s) failed`);
console.log("\nAll AST + extension checks passed.");
