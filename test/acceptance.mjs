/**
 * Standalone acceptance test for dsh-plugin-open-in-app-fix.
 * Runs the plugin's real entry, then exercises the real spawn shapes.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = new URL('../lib/index.js', import.meta.url).href;

// Self-contained scratch space: children report their environment through files, so the
// directory must exist and must not depend on any checkout or workspace layout.
const TMP = mkdtempSync(join(tmpdir(), 'open-in-app-fix-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

const pristine = ChildProcess.prototype.spawn;
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** A fresh environment object per case: the plugin must never mutate a caller's. */
const freshEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1' });

// Collected through a file so an 'ignore'-stdio child can still report.
async function observed(label, options) {
  const out = join(TMP, `env-${label}.txt`);
  rmSync(out, { force: true });
  const script = `require('fs').writeFileSync(${JSON.stringify(out)}, String(process.env.ELECTRON_RUN_AS_NODE))`;
  const child = spawn(process.execPath, ['-e', script], options);
  child.unref?.();
  let value = '<no report>';
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(out)) {
      const text = readFileSync(out, 'utf8');
      if (text !== '') { value = text; break; }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return value;
}

console.log('--- before plugin load ---');
check('detached+ignore keeps the selector while unpatched (reproduces the bug)',
  (await observed('pre', { detached: true, stdio: 'ignore', env: freshEnv() })) === '1');

console.log('\n--- load plugin ---');
const plugin = await import(PLUGIN);
const disposers = [];
const ctx = { effect: (fn) => { disposers.push(fn()); }, logger: { info: () => {}, warn: () => {} } };
check('plugin name', plugin.name === 'open-in-app-fix', plugin.name);
plugin.apply(ctx);
check('prototype patched', ChildProcess.prototype.spawn !== pristine);

console.log('\n--- after patch ---');
check('A detached + stdio:"ignore" (open-in-app GUI adapter) drops the selector',
  (await observed('A', { detached: true, stdio: 'ignore', env: freshEnv() })) === 'undefined');
check('B stdio:"ignore" without detached keeps it',
  (await observed('B', { stdio: 'ignore', env: freshEnv() })) === '1');
check('C detached + ["ignore","pipe","pipe"] (bash session shape) keeps it',
  (await observed('C', { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: freshEnv() })) === '1');
check('D detached + ["ignore","ignore","ignore"] (normalized form) drops the selector',
  (await observed('D', { detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: freshEnv() })) === 'undefined');
check('E detached + ["ignore","ignore","ignore","ipc"] (runner shape) keeps it',
  (await observed('E', { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: freshEnv() })) === '1');

console.log('\n--- caller-owned data ---');
const reused = freshEnv();
await observed('reuse1', { detached: true, stdio: 'ignore', env: reused });
check('the caller\'s env object is not mutated by a patched launch', reused.ELECTRON_RUN_AS_NODE === '1',
  JSON.stringify(reused.ELECTRON_RUN_AS_NODE));
check('the same object still works for a later non-GUI launch',
  (await observed('reuse2', { stdio: 'ignore', env: reused })) === '1');
const noEnv = await observed('F', { detached: true, stdio: 'ignore' });
console.log(`INFO  detached+ignore with no explicit env (inherits process.env): ${noEnv}`);

console.log('\n--- idempotency ---');
const afterFirst = ChildProcess.prototype.spawn;
plugin.apply(ctx);
check('a second apply does not stack another patch', ChildProcess.prototype.spawn === afterFirst);
check('A still correct after double apply',
  (await observed('A2', { detached: true, stdio: 'ignore', env: freshEnv() })) === 'undefined');

console.log('\n--- dispose ---');
for (const dispose of disposers) dispose();
check('dispose restores the original method', ChildProcess.prototype.spawn === pristine);
check('detached+ignore keeps the selector again after dispose',
  (await observed('post', { detached: true, stdio: 'ignore', env: freshEnv() })) === '1');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
