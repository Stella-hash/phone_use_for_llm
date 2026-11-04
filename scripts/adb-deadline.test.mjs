import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdbClient } from '../dist/adb.js';
import { withDeadline, DeadlineExceeded } from '../dist/deadline.js';

test('real subprocess is killed at the shared ADB deadline', { skip: process.platform === 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-adb-deadline-'));
  const platform = path.join(directory, 'platform-tools');
  fs.mkdirSync(platform);
  fs.writeFileSync(path.join(platform, 'adb'), '#!/bin/sh\nexec sleep 10\n', { mode: 0o700 });
  const previous = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = directory;
  try {
    const start = performance.now();
    assert.throws(() => withDeadline(100, () => new AdbClient().adb('test', 'get-state')), DeadlineExceeded);
    assert(performance.now() - start < 2000);
  } finally {
    if (previous === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
