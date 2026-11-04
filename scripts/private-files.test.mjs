import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { privateDirectory, writePrivate, readPrivateSnapshot } from '../dist/private-files.js';

test('private file snapshots preserve stable identity and reject excessive size on this filesystem', () => {
  fs.mkdirSync('.runtime', { recursive: true });
  const dir = privateDirectory(fs.mkdtempSync(path.resolve('.runtime/private-file-')));
  const file = path.join(dir, 'synthetic.txt'); writePrivate(file, 'synthetic file contents');
  try {
    const before = readPrivateSnapshot(file, 64);
    assert.equal(before.text, 'synthetic file contents');
    assert.deepEqual(readPrivateSnapshot(file, 64), before);
    assert.throws(() => readPrivateSnapshot(file, 2), /Invalid private file/);
  } catch (error) {
    const fd = fs.openSync(file, 'r');
    try {
      const fields = s => Object.fromEntries(['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(k => [k, String(s[k])]));
      throw new Error('Synthetic filesystem diagnostics: ' + JSON.stringify({ path: fields(fs.lstatSync(file, { bigint: true })), descriptor: fields(fs.fstatSync(fd, { bigint: true })) }), { cause: error });
    } finally { fs.closeSync(fd); }
  }
});
