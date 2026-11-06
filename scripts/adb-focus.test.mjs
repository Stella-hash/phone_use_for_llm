import test from 'node:test';
import assert from 'node:assert/strict';
import { AdbClient } from '../dist/adb.js';

// Synthetic Android window dumps: global focus is outside the windows subcommand.
const windows = 'WINDOW MANAGER WINDOWS (dumpsys window windows)\n  Window #0 Window{abcd u0 org.example.game/.MainActivity}:\n';
const focusedApp = '  mFocusedApp=ActivityRecord{ef01 u0 org.example.game/.MainActivity t7}\n';
function device(globalState) {
  const adb = new AdbClient();
  adb.shell = (_serial, ...command) => {
    if (command.join(' ') === 'dumpsys window windows') return windows;
    if (command.join(' ') === 'dumpsys window') return windows + focusedApp + globalState;
    throw new Error('Unexpected device query in synthetic focus fixture');
  };
  return adb;
}

test('focused package uses global window state when the windows subcommand omits focus', () => {
  assert.equal(device('  mCurrentFocus=Window{abcd u0 org.example.game/.MainActivity}\n')
    .getFocusedPackage('synthetic-device'), 'org.example.game');
});

test('focused overlay wins over a resumed or focused app behind it', () => {
  assert.equal(device('  mCurrentFocus=Window{abce u0 com.android.permissioncontroller/.PermissionDialog}\n')
    .getFocusedPackage('synthetic-device'), 'com.android.permissioncontroller');
});

test('missing, null or malformed current focus stays unknown despite an underlying app', () => {
  for (const state of ['', '  mCurrentFocus=null\n', '  mCurrentFocus=Window{abcd u0 invalid-title}\n'])
    assert.equal(device(state).getFocusedPackage('synthetic-device'), 'unknown');
});

test('failed window query propagates instead of guessing a focused package', () => {
  const adb = new AdbClient();
  adb.shell = () => { throw new Error('synthetic ADB failure'); };
  assert.throws(() => adb.getFocusedPackage('synthetic-device'), /synthetic ADB failure/);
});
