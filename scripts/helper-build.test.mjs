import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('helper build excludes removed classes and publishes only after verification (synthetic tools)', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/helper-build-test.py'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
