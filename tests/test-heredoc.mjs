import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(join(ROOT, "extensions/no-heredoc/index.ts"));
const { hasHeredoc } = mod;

const cases = [
  { cmd: "cat << 'EOF' > foo.txt\nhello\nEOF", expected: true },
  { cmd: "python3 - << 'PY'\nprint(1)\nPY", expected: true },
  { cmd: 'git commit -m "$(cat <<EOF\nmsg\nEOF\n)"', expected: true },
  { cmd: 'grep "foo" <<< "foobar"', expected: false },
  { cmd: 'echo "a << b"', expected: false },
];

let failures = 0;
for (const { cmd, expected } of cases) {
  const got = await hasHeredoc(cmd);
  if (got !== expected) {
    failures += 1;
    console.log(`FAIL  ${JSON.stringify(cmd.slice(0, 40))}: expected ${expected}, got ${got}`);
  } else {
    console.log(`PASS  ${JSON.stringify(cmd.slice(0, 40))}: ${got}`);
  }
}
console.log(failures === 0 ? "\nall heredoc checks passed" : `\n${failures} heredoc check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
