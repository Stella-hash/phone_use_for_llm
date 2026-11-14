import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { childEnvironment, discover, discoveryEnvironment, runDiscoveryWorker, isOwnedProcess, locations, main, processIdentity, requireBuild, validateConfig, verifyHostSelection } from './phone.mjs';

const configured = {
  captureId: '00000000-TEST-SPARE',
  port: 7390,
  usbDeviceId: '00000000-1111111111111111',
};
const normalized = { ...configured, directTouch: true, directKeyboard: true };

test('requires both exact device identities and the fixed local port', () => {
  assert.deepEqual(validateConfig(configured), normalized);
  for (const invalid of [
    {}, null, [],
    { ...configured, captureId: '' },
    { ...configured, captureId: 'REPLACE_WITH_DEVICE_ID' },
    { ...configured, captureId: ' device ' },
    { ...configured, captureId: 'device\nother' },
    { ...configured, port: '7390' },
    { ...configured, port: 0 },
    { ...configured, host: '0.0.0.0' },
    { ...configured, usbDeviceId: undefined },
    { ...configured, usbDeviceId: 'auto' },
    { ...configured, usbDeviceId: '00000000-1111111111111111\n' },
  ]) assert.throws(() => validateConfig(invalid));
});

test('omitted and existing true direct flags select the same USB-only configuration', () => {
  for (const flags of [{}, { directTouch: true }, { directKeyboard: true },
    { directTouch: true, directKeyboard: true }]) {
    assert.deepEqual(validateConfig({ ...configured, ...flags }), normalized);
  }
  for (const route of ['directTouch', 'directKeyboard']) {
    for (const value of [undefined, null, false, 'true', 1, 0]) {
      assert.throws(() => validateConfig({ ...configured, [route]: value }), new RegExp(route));
    }
  }
});

test('legacy and mixed settings cannot activate an alternative input route', () => {
  for (const legacy of [
    { bluetoothHost: '01234567-89ab-cdef-0123-456789abcdef' },
    { bluetoothHost: undefined }, { bluetoothHost: null },
    { heldDragProfile: false }, { heldDragProfile: true },
    { heldDragProfile: '/other/phone.json' },
  ]) {
    for (const config of [configured, normalized]) {
      assert.throws(() => validateConfig({ ...config, ...legacy }), /USB-only/);
    }
  }
});

test('example config has one transport after replacing the two device placeholders', async () => {
  const example = JSON.parse(await readFile(new URL('./config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(example).sort(), ['captureId', 'port', 'usbDeviceId']);
  assert.deepEqual(validateConfig({ ...example, captureId: configured.captureId,
    usbDeviceId: configured.usbDeviceId }), normalized);
});

test('shell settings cannot change selectors, input helpers or Bluetooth disablement', () => {
  const paths = locations('/test/repo');
  const inherited = {
    PATH: '/test/bin', IPHONE_USE_BLUETOOTH_DISABLED: '0',
    IPHONE_USE_BLUETOOTH_HOST: 'other-device', IPHONE_USE_HELD_DRAG_PROFILE: '/other/profile.json',
    IPHONE_USE_TRACE_POINTER: '1', IPHONE_USE_ALLOW_USB_TETHER_PREEMPTION: '1', IPHONE_USE_DEVICE_ID: 'wrong', IPHONE_USE_PORT: '9999',
    IPHONE_USE_STATE_DIR: '/wrong', IPHONE_USE_USB_DEVICE_ID: 'wrong',
    IPHONE_USE_USB_CLIPBOARD_PYTHON: '/other/python', IPHONE_USE_AX_HELPER: '/other/reader.py',
    IPHONE_USE_TOUCH_HELPER: '/other/touch.py', IPHONE_USE_KEYBOARD_HELPER: '/other/keyboard.py',
  };
  const original = { ...inherited };
  const env = childEnvironment(configured, paths, inherited);
  assert.equal(env.IPHONE_USE_BLUETOOTH_DISABLED, '1');
  for (const name of ['IPHONE_USE_BLUETOOTH_HOST', 'IPHONE_USE_HELD_DRAG_PROFILE', 'IPHONE_USE_TRACE_POINTER', 'IPHONE_USE_ALLOW_USB_TETHER_PREEMPTION']) {
    assert.equal(Object.hasOwn(env, name), false);
  }
  assert.equal(env.IPHONE_USE_DEVICE_ID, configured.captureId);
  assert.equal(env.IPHONE_USE_USB_DEVICE_ID, configured.usbDeviceId);
  assert.equal(env.IPHONE_USE_PORT, '7390');
  assert.equal(env.IPHONE_USE_STATE_DIR, paths.state);
  assert.equal(env.IPHONE_USE_USB_CLIPBOARD_PYTHON, paths.usbPython);
  assert.equal(env.IPHONE_USE_AX_HELPER, paths.accessibilityHelper);
  assert.equal(env.IPHONE_USE_TOUCH_HELPER, paths.touchHelper);
  assert.equal(env.IPHONE_USE_KEYBOARD_HELPER, paths.keyboardHelper);
  assert.equal(env.PATH, inherited.PATH);
  assert.deepEqual(inherited, original);
  assert.throws(() => childEnvironment({ ...configured, directTouch: false }, paths), /USB-only/);
});

test('MCP launch requires a USB-only host with both direct routes', () => {
  const valid = { bluetoothEnabled: false, bluetoothHosts: [], directTouch: true, directKeyboard: true };
  for (const config of [configured, normalized]) {
    assert.doesNotThrow(() => verifyHostSelection(valid, config));
    for (const invalid of [
      {}, { ...valid, bluetoothEnabled: undefined }, { ...valid, bluetoothEnabled: true },
      { ...valid, bluetoothEnabled: 'false' }, { ...valid, bluetoothHosts: undefined },
      { ...valid, bluetoothHosts: null },
      { ...valid, bluetoothHosts: [{ host: 'other', inputAllowed: false }] },
      { ...valid, bluetoothHosts: [{ host: 'other', inputAllowed: true }] },
    ]) assert.throws(() => verifyHostSelection(invalid, config), /USB-only/);
    for (const route of ['directTouch', 'directKeyboard']) {
      for (const value of [undefined, false, 'true', 1]) {
        assert.throws(() => verifyHostSelection({ ...valid, [route]: value }, config), new RegExp(route));
      }
    }
  }
});

test('retired pointer diagnostics are not a managed launcher command', async () => {
  for (const args of [['trace', 'status'], ['trace', 'off'], ['trace', '60'], ['ble'], ['mcp', 'extra']]) {
    await assert.rejects(main(args, locations('/does-not-exist')), /Usage:/);
  }
});

test('PID reuse, different executable and missing process do not establish ownership', () => {
  const record = { pid: 1234, started: 'start A', executable: '/driver/iphone-use' };
  assert.equal(isOwnedProcess(record, { ...record }, record.executable), true);
  for (const observed of [null, { ...record, pid: 5678 }, { ...record, started: 'start B' }, { ...record, executable: '/usr/bin/other' }]) {
    assert.equal(isOwnedProcess(record, observed, record.executable), false);
  }
  assert.equal(isOwnedProcess(record, record, '/different/iphone-use'), false);
});

async function temporary(t) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'phone-use-ios-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  return locations(repo);
}

test('missing or changed build fails before native MCP launch, without building', async t => {
  const paths = await temporary(t);
  await mkdir(paths.patches, { recursive: true });
  await writeFile(path.join(paths.patches, 'test.patch'), 'fixture patch\n');
  await assert.rejects(requireBuild(paths), /No current pinned build/);
  if (process.platform !== 'darwin') return;
  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(paths.config, JSON.stringify(configured));
  await assert.rejects(main(['mcp'], paths), /No current pinned build/);
  assert.equal((await readdir(paths.repo)).includes('.runtime'), false);
});

test('stop refuses a live unrelated process and preserves its record', { skip: process.platform !== 'darwin' }, async t => {
  const paths = await temporary(t);
  await mkdir(paths.runtime, { recursive: true });
  const current = processIdentity(process.pid);
  assert.ok(current);
  const record = { ...current, executable: paths.binary };
  await writeFile(paths.pid, JSON.stringify(record));
  await assert.rejects(main(['stop'], paths), /different process; no signal was sent/);
  assert.deepEqual(JSON.parse(await readFile(paths.pid, 'utf8')), record);
  assert.ok(processIdentity(process.pid));
});


test('setup discovery needs no local config and cannot start a concurrent host', async t => {
  const paths = await temporary(t);
  const calls = [];
  const result = { schema_version: 1, status: 'configuration_candidate', config_candidate: configured };
  const worker = async (...args) => { calls.push(args); return result; };
  assert.equal(await discover(paths, { checkBuild: async () => {}, hosts: () => [], worker }), result);
  assert.equal(calls[0][0], paths.binary);
  assert.deepEqual(calls[0][1], ['--discover-usb-setup']);
  assert.equal(calls[0][2].env.IPHONE_USE_BLUETOOTH_DISABLED, '1');
  assert.deepEqual(await readdir(paths.repo), []);
  await assert.rejects(discover(paths, { checkBuild: async () => {}, hosts: () => [1234], worker }), /host is running/);
  assert.equal(calls.length, 1);
  await assert.rejects(discover(paths, { checkBuild: async () => { throw Error('build missing'); }, hosts: () => [], worker }), /build missing/);
  assert.equal(calls.length, 1);
});

test('setup discovery clears inherited selectors and unsafe USB-network override', () => {
  const paths = locations('/test/repo');
  const inherited = {
    PATH: '/test/bin', IPHONE_USE_DEVICE_ID: 'wrong', IPHONE_USE_USB_DEVICE_ID: 'wrong',
    IPHONE_USE_BLUETOOTH_DISABLED: '0', IPHONE_USE_BLUETOOTH_HOST: 'wrong',
    IPHONE_USE_TOUCH_HELPER: '/other/helper', IPHONE_USE_ALLOW_USB_TETHER_PREEMPTION: '1',
  };
  const original = { ...inherited };
  const env = discoveryEnvironment(paths, inherited);
  assert.deepEqual(env, { PATH: '/test/bin', IPHONE_USE_BLUETOOTH_DISABLED: '1', IPHONE_USE_STATE_DIR: paths.state });
  assert.deepEqual(inherited, original);
});

test('discovery preserves explicit incomplete inventory and rejects an invalid candidate', async t => {
  const paths = await temporary(t);
  const options = { checkBuild: async () => {}, hosts: () => [] };
  const incomplete = { schema_version: 1, status: 'capture_unavailable', usb_devices: [{ usbDeviceId: configured.usbDeviceId }] };
  assert.equal(await discover(paths, { ...options, worker: async () => incomplete }), incomplete);
  await assert.rejects(discover(paths, { ...options, worker: async () => ({ status: 'configuration_candidate', config_candidate: {} }) }), /captureId/);
});

test('discovery worker preserves success and explicit non-success JSON', async () => {
  for (const [status, code] of [['configuration_candidate', 0], ['ambiguous_devices', 2]]) {
    const body = { schema_version: 1, status, name: '测试手机' };
    const program = `process.stdout.write(JSON.stringify(${JSON.stringify(body)})); process.exitCode=${code}`;
    assert.deepEqual(await runDiscoveryWorker(process.execPath, ['-e', program]), body);
  }
  await assert.rejects(runDiscoveryWorker(process.execPath, ['-e', 'console.log("not json")']), /Discovery failed/);
  await assert.rejects(runDiscoveryWorker(process.execPath, ['-e', 'console.log(JSON.stringify({schema_version:1,status:"ambiguous_devices"}))']), /inconsistent status/);
});

test('discovery worker timeout is bounded without a second execution', async () => {
  const program = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
  const start = Date.now();
  await assert.rejects(runDiscoveryWorker(process.execPath, ['-e', program], { timeoutMs: 200, cleanupMs: 50 }), /cleanup may be pending/);
  assert.ok(Date.now() - start < 3000);
});


test('discovery signal handlers are removed after success, protocol failure and spawn failure', async () => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const counts = () => signals.map(signal => process.listenerCount(signal));
  const before = counts();
  await runDiscoveryWorker(process.execPath, ['-e', 'console.log(JSON.stringify({schema_version:1,status:"configuration_candidate"}))']);
  assert.deepEqual(counts(), before);
  await assert.rejects(runDiscoveryWorker(process.execPath, ['-e', 'console.log("bad")']));
  assert.deepEqual(counts(), before);
  await assert.rejects(runDiscoveryWorker('/does-not-exist/discovery-worker', []));
  assert.deepEqual(counts(), before);
});

test('parent termination forwards cancellation, preserves the kill bound and leaves no worker', { timeout: 15000 }, async t => {
  const paths = await temporary(t);
  const launcherURL = new URL('./phone.mjs', import.meta.url).href;
  for (const [index, signal] of ['SIGINT', 'SIGTERM', 'SIGHUP'].entries()) {
    const mode = signal === 'SIGTERM' ? 'ignore' : 'settle';
    const ready = path.join(paths.repo, `ready-${index}.json`);
    const received = path.join(paths.repo, `received-${index}.json`);
    const report = path.join(paths.repo, `report-${index}.json`);
    const worker = path.join(paths.repo, `worker-${index}.mjs`);
    const parent = path.join(paths.repo, `parent-${index}.mjs`);
    await writeFile(worker, `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {
        writeFileSync(${JSON.stringify(received)}, JSON.stringify({signal:'SIGTERM'}));
        if (${JSON.stringify(mode)} === 'settle') setTimeout(() => {
          console.log(JSON.stringify({schema_version:1,status:'cancelled_or_deadline',cleanup:'settled'}));
          process.exit(2);
        }, 30);
      });
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid}));
      setInterval(() => {}, 1000);
    `);
    await writeFile(parent, `
      import { runDiscoveryWorker } from ${JSON.stringify(launcherURL)};
      import { writeFileSync } from 'node:fs';
      const signals=['SIGINT','SIGTERM','SIGHUP'];
      const before=signals.map(signal=>process.listenerCount(signal));
      try {
        await runDiscoveryWorker(process.execPath,[${JSON.stringify(worker)}],{timeoutMs:4000,cleanupMs:120});
        process.exitCode=3;
      } catch(error) {
        writeFileSync(${JSON.stringify(report)},JSON.stringify({error:error.message,before,after:signals.map(signal=>process.listenerCount(signal))}));
        process.exitCode=1;
      }
    `);
    const child = spawn(process.execPath, [parent], { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
    const closed = once(child, 'close');
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    let workerPID;
    for (let attempt = 0; attempt < 200 && !workerPID; attempt++) {
      try { workerPID = JSON.parse(await readFile(ready, 'utf8')).pid; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!workerPID) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(workerPID, diagnostic || 'fixture worker did not start');
    const interrupted = Date.now();
    child.kill(signal);
    const [code, exitSignal] = await closed;
    assert.equal(code, 1, diagnostic);
    assert.equal(exitSignal, null);
    assert.ok(Date.now() - interrupted < 2000, 'parent lost its cleanup bound');
    assert.deepEqual(JSON.parse(await readFile(received, 'utf8')), { signal: 'SIGTERM' });
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.match(result.error, new RegExp(signal));
    assert.deepEqual(result.after, result.before);
    assert.throws(() => process.kill(workerPID, 0), { code: 'ESRCH' });
  }
});
