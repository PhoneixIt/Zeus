/*
 * Tests for the bridge's path-pair validation. These assert that folder-summary
 * REFUSES rather than guesses. Nothing here launches a mission or touches a file.
 *
 * Run: node bridge-verdict.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvidence, validatePathPair } from './bridge.js';

let failed = 0;
function check(ok, msg) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}

// ---------- verdict logic (unchanged behaviour) ----------
const verdicts = [
  ['clean pass with banner', '  PASS  every step verified\n=== PASS ===\n', 'verified'],
  ['a FAIL line present', '  PASS  a\n  FAIL  b\n=== PASS ===\n', 'failed'],
  ['failure banner', '  PASS  a\n=== 2 FAILURE(S) ===\n', 'failed'],
  ['no verifiable output, exit 0', 'Mission completed via governed executor\n', 'indeterminate'],
  ['empty stdout, exit 0', '', 'indeterminate'],
  ['PASS lines but no banner', '  PASS  something\n', 'indeterminate'],
];
console.log('=== verdict logic ===');
for (const [label, stdout, expect] of verdicts) {
  const ev = readEvidence(stdout);
  check(ev.verdict === expect, `${label} -> ${ev.verdict} (expected ${expect})`);
}

// ---------- path validation ----------
// A real directory on disk, so "does it exist" is a genuine check.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-path-test-'));
const goodSrc = path.join(tmp, 'src');
const goodOut = path.join(tmp, 'out.txt');
fs.mkdirSync(goodSrc);
fs.writeFileSync(path.join(goodSrc, 'a.txt'), 'a');

console.log('');
console.log('=== path-pair validation ===');

const accepts = (s, o) => validatePathPair(s, o).ok === true;
const reason = (s, o) => validatePathPair(s, o).reason;

check(accepts(goodSrc, goodOut), 'accepts a real source folder and a new output path');
check(!accepts('C:\\nope\\nothere', goodOut), 'refuses a source folder that does not exist');
check(!accepts(goodSrc, path.join(tmp, 'sub', 'x.txt')), 'refuses an output folder that does not exist');
check(!accepts(goodSrc, path.join(goodSrc, 'a.txt')), 'refuses a source that is a file, not a folder');
check(!accepts('relative/path', goodOut), 'refuses a relative source path');
check(!accepts(goodSrc, 'relative/out.txt'), 'refuses a relative output path');
check(!accepts(goodSrc, goodSrc + '\\..\\..\\Windows'), 'refuses ".." traversal in the source');
check(!accepts(goodSrc, tmp + '\\..\\evil.txt'), 'refuses ".." traversal in the output');
check(!accepts(goodSrc, tmp + '\\evil.exe'), 'refuses an output name that is not .txt');
check(!accepts(goodSrc, tmp + '\\a b and summarise c.txt'), 'refuses a name containing spaces (word injection)');
check(!accepts(goodSrc, tmp + '\\a\\b.txt'), 'refuses a name containing a separator');
check(!accepts('', goodOut), 'refuses an empty source');
check(!accepts(goodSrc, ''), 'refuses an empty output');
check(!accepts('\\\\server\\share', goodOut), 'refuses a UNC path (drive-lettered absolute paths only)');
check(reason('\\\\server\\share', goodOut).includes('absolute'), 'the UNC refusal names the reason');

// The output NAME is the caller's. Any bare name ending .txt is honoured; nothing else is.
console.log('');
console.log('=== output file names ===');
for (const name of ['my-notes.txt', 'quarterly-report.txt', 'inventory.txt', 'Q1_2026.txt', 'a.txt']) {
  check(accepts(goodSrc, path.join(tmp, name)), `accepts the caller-chosen name "${name}"`);
}
for (const name of ['evil.exe', 'evil.bat', 'evil.ps1', 'evil.js', 'evil.cmd', 'evil.txt.exe', 'notes']) {
  check(!accepts(goodSrc, path.join(tmp, name)), `refuses the unsupported name "${name}"`);
}
check(!accepts(goodSrc, path.join(tmp, 'a b.txt')), 'refuses a name with a space');
check(!accepts(goodSrc, path.join(tmp, 'a;b.txt')), 'refuses a name with a shell metacharacter');
check(!accepts(goodSrc, path.join(tmp, 'a$b.txt')), 'refuses a name with a substitution character');
check(!accepts(goodSrc, path.join(tmp, 'a%20b.txt')), 'refuses a name with percent-encoding');
check(!accepts(goodSrc, path.join(tmp, '.txt')), 'refuses a name that is only an extension');

fs.writeFileSync(goodOut, 'already here');
check(!accepts(goodSrc, goodOut), 'refuses to overwrite an existing output file');
check(reason(goodSrc, goodOut).includes('will not overwrite'), 'overwrite refusal says so explicitly');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`);
process.exit(failed ? 1 : 0);