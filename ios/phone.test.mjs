import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { childEnvironment, discover, discoveryEnvironment, runDiscoveryWorker, isOwnedProcess, locations, main, processIdentity, requireBuild, setupUSB, usbLockForProfile, validateConfig, verifyHostSelection } from './phone.mjs';

const configured = {
  port: 7390,
  usbDeviceId: '00000000-1111111111111111',
};
const normalized = { ...configured, directTouch: true, directKeyboard: true };

test('requires one exact physical device identity and defaults to the fixed local port', () => {
  assert.deepEqual(validateConfig(configured), normalized);
  assert.deepEqual(validateConfig({ usbDeviceId: configured.usbDeviceId }), normalized);
  for (const invalid of [
    {}, null, [],
    { ...configured, captureId: '' },
    { ...configured, captureId: 'REPLACE_WITH_DEVICE_ID' },
    { ...configured, captureId: ' device ' },
    { ...configured, captureId: 'device\nother' },
    { ...configured, port: '7390' },
    { ...configured, port: 0 },
    { ...configured, port: undefined },
    { ...configured, port: null },
    { ...configured, host: '0.0.0.0' },
    { ...configured, usbDeviceId: undefined },
    { ...configured, usbDeviceId: 'auto' },
    { ...configured, usbDeviceId: '00000000-1111111111111111\n' },
  ]) assert.throws(() => validateConfig(invalid));
});

test('legacy captureId is accepted only as the identical physical UDID, then removed', () => {
  assert.deepEqual(validateConfig({ ...configured, captureId: configured.usbDeviceId }), normalized);
  for (const captureId of [undefined, null, '', '00000000-TEST-SPARE',
    '00000000-2222222222222222', '00000000-0000-4000-8000-000000000001']) {
    assert.throws(() => validateConfig({ ...configured, captureId }), /AV capture ID.*remove captureId/);
  }
  const usbDeviceId = '0123abcd-ABCDEF0123456789';
  assert.throws(() => validateConfig({ usbDeviceId, captureId: usbDeviceId.toLowerCase() }), /differs/);
});

test('physical USB identity accepts exactly the Swift and Python UDID formats', () => {
  for (const usbDeviceId of ['0123abcd-ABCDEF0123456789', 'AbCdEf0123'.repeat(4)]) {
    assert.equal(validateConfig({ ...configured, usbDeviceId }).usbDeviceId, usbDeviceId);
  }
  for (const usbDeviceId of ['-'.repeat(25), 'a'.repeat(25), 'a'.repeat(20), 'a'.repeat(39), 'a'.repeat(41),
    '01234567-89ab-cdef-0123-456789abcdef', '0123456-0123456789abcdef', '012345678-0123456789abcdef',
    '01234567-0123456789abcde', '01234567-0123456789abcdef0', '01234567--123456789abcdef',
    '01234567-0123456789abcdeg', ` ${configured.usbDeviceId}`, `${configured.usbDeviceId}\n`,
    `${configured.usbDeviceId}\r`, `${configured.usbDeviceId}\u2028`, `${configured.usbDeviceId}\0`]) {
    assert.throws(() => validateConfig({ ...configured, usbDeviceId }), /physical UDID/);
  }
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

test('example config needs only one physical device placeholder', async () => {
  const example = JSON.parse(await readFile(new URL('./config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(example), ['usbDeviceId']);
  assert.deepEqual(validateConfig({ ...example, usbDeviceId: configured.usbDeviceId }), normalized);
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
    IPHONE_USE_USB_SCREENSHOT_HELPER: '/other/screenshot.py',
    PYTHONPATH: '/untrusted/imports', PYTHONHOME: '/untrusted/python', PYTHONUSERBASE: '/untrusted/user-site',
    PYTHONSTARTUP: '/untrusted/startup.py',
  };
  const original = { ...inherited };
  const env = childEnvironment(configured, paths, inherited);
  assert.equal(env.IPHONE_USE_BLUETOOTH_DISABLED, '1');
  for (const name of ['IPHONE_USE_BLUETOOTH_HOST', 'IPHONE_USE_HELD_DRAG_PROFILE', 'IPHONE_USE_TRACE_POINTER', 'IPHONE_USE_ALLOW_USB_TETHER_PREEMPTION']) {
    assert.equal(Object.hasOwn(env, name), false);
  }
  assert.equal(env.IPHONE_USE_DEVICE_ID, configured.usbDeviceId);
  assert.equal(env.IPHONE_USE_USB_DEVICE_ID, configured.usbDeviceId);
  assert.equal(env.IPHONE_USE_PORT, '7390');
  assert.equal(env.IPHONE_USE_STATE_DIR, paths.state);
  assert.equal(env.IPHONE_USE_USB_CLIPBOARD_PYTHON, paths.usbPython);
  assert.equal(env.IPHONE_USE_AX_HELPER, paths.accessibilityHelper);
  assert.equal(env.IPHONE_USE_TOUCH_HELPER, paths.touchHelper);
  assert.equal(env.IPHONE_USE_KEYBOARD_HELPER, paths.keyboardHelper);
  assert.equal(env.IPHONE_USE_USB_SCREENSHOT_HELPER, paths.usbScreenshotHelper);
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(Object.keys(env).some(key => key.startsWith('PYTHON')), false);
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

test('USB setup selects only supported CPython 3.12/macOS architecture locks', () => {
  const paths = locations('/test/repo');
  const profile = { implementation: 'cpython', version: [3, 12], system: 'Darwin', macos: '14.0', machine: 'arm64' };
  for (const machine of ['arm64', 'x86_64']) {
    assert.equal(usbLockForProfile(paths, { ...profile, machine }), paths.usbLocks[machine]);
  }
  for (const invalid of [null, {}, { ...profile, version: [3, 11] }, { ...profile, version: [3, 13] },
    { ...profile, implementation: 'pypy' }, { ...profile, machine: 'i386' }, { ...profile, machine: '__proto__' },
    { ...profile, system: 'Linux' }, { ...profile, macos: '13.6' }, { ...profile, macos: '' }]) {
    assert.throws(() => usbLockForProfile(paths, invalid), /CPython 3.12/);
  }
});

test('committed USB locks contain exact transitive pins and hashes for the direct dependency', async () => {
  const source = await readFile(new URL('./requirements-usb.txt', import.meta.url), 'utf8');
  const direct = source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const architecture of ['arm64', 'x86_64']) {
    const text = await readFile(new URL(`./requirements-usb-macos-${architecture}.lock`, import.meta.url), 'utf8');
    const entries = text.replace(/\\\r?\n/g, ' ').split('\n').map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    assert.ok(entries.length > direct.length, 'lock must include transitive dependencies');
    for (const entry of entries) {
      assert.match(entry, /^[a-z0-9][a-z0-9._-]*==[^\s;]+(?:\s+--hash=sha256:[a-f0-9]{64})+$/i);
    }
    assert.equal(new Set(entries.map(entry => entry.split('==')[0])).size, entries.length);
    for (const requirement of direct) assert.ok(entries.some(entry => entry.startsWith(`${requirement} `)));
  }
});

test('USB setup uses an isolated profile probe and hash-checked wheel-only sync, never ambient installer overrides', async t => {
  const paths = await temporary(t), calls = [];
  await mkdir(path.dirname(paths.usbLocks.arm64), { recursive: true });
  await writeFile(paths.usbLocks.arm64, 'fixture==1.0 --hash=sha256:fixture\n');
  const inherited = { PATH: '/test/bin', PYTHONPATH: '/untrusted', PYTHONHOME: '/untrusted',
    UV_NO_VERIFY_HASHES: '1', UV_PYTHON: '/system/python', UV_INDEX: 'https://untrusted.invalid',
    PIP_INDEX_URL: 'https://untrusted.invalid', VIRTUAL_ENV: '/system/venv', CONDA_PREFIX: '/system/conda',
    MACOSX_DEPLOYMENT_TARGET: '10.9' };
  const original = { ...inherited };
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('venv')) {
      await mkdir(path.dirname(paths.usbPython), { recursive: true });
      await writeFile(paths.usbPython, 'fixture', { mode: 0o700 });
    }
    if (command === paths.usbPython) return JSON.stringify({ implementation: 'cpython', version: [3, 12],
      system: 'Darwin', macos: '15.0', machine: 'arm64', is_venv: true,
      prefix: await realpath(path.dirname(path.dirname(paths.usbPython))) });
    return '';
  };
  await setupUSB(paths, { runCommand: runner, hosts: () => [], inherited, platform: 'darwin' });
  assert.deepEqual(calls[0].args, ['--no-config', 'venv', '--python', '3.12', path.dirname(path.dirname(paths.usbPython))]);
  assert.equal(calls[1].command, paths.usbPython);
  assert.deepEqual(calls[1].args.slice(0, 3), ['-I', '-B', '-c']);
  assert.deepEqual(calls[2].args, ['--no-config', 'pip', 'sync', '--python', paths.usbPython,
    '--require-hashes', '--no-build', '--strict', '--default-index', 'https://pypi.org/simple', paths.usbLocks.arm64]);
  for (const call of calls) assert.deepEqual(call.options.env, { PATH: '/test/bin' });
  assert.deepEqual(inherited, original);
});

test('USB setup rejects a running host or non-private interpreter before package changes', async t => {
  const paths = await temporary(t), calls = [];
  await mkdir(path.dirname(paths.usbPython), { recursive: true });
  await writeFile(paths.usbPython, 'fixture', { mode: 0o700 });
  const profile = { implementation: 'cpython', version: [3, 12], system: 'Darwin', macos: '15.0',
    machine: 'arm64', is_venv: true, prefix: await realpath(path.dirname(path.dirname(paths.usbPython))) };
  const options = { hosts: () => [], platform: 'darwin', runCommand: (command, args) => {
    calls.push({ command, args }); return JSON.stringify(profile);
  } };
  await assert.rejects(setupUSB(paths, { ...options, hosts: () => [1234] }), /host is running/);
  assert.equal(calls.length, 0);
  profile.is_venv = false;
  await assert.rejects(setupUSB(paths, options), /outside the configured private virtual environment/);
  profile.is_venv = true; profile.prefix = '/system/venv';
  await assert.rejects(setupUSB(paths, options), /outside the configured private virtual environment/);
  profile.prefix = await realpath(path.dirname(path.dirname(paths.usbPython))); profile.version = [3, 11];
  await assert.rejects(setupUSB(paths, options), /CPython 3.12/);
  assert.ok(calls.every(call => call.command === paths.usbPython));
});

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
  assert.deepEqual(await discover(paths, { checkBuild: async () => {}, hosts: () => [], worker }), result);
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
    IPHONE_USE_USB_SCREENSHOT_HELPER: '/other/screenshot.py',
    PYTHONPATH: '/untrusted', PYTHONHOME: '/untrusted', PYTHONUSERBASE: '/untrusted',
  };
  const original = { ...inherited };
  const env = discoveryEnvironment(paths, inherited);
  assert.deepEqual(env, { PATH: '/test/bin', IPHONE_USE_BLUETOOTH_DISABLED: '1', IPHONE_USE_STATE_DIR: paths.state });
  assert.deepEqual(inherited, original);
});

test('discovery preserves explicit incomplete inventory and rejects an invalid candidate', async t => {
  const paths = await temporary(t);
  const options = { checkBuild: async () => {}, hosts: () => [] };
  const incomplete = { schema_version: 1, status: 'usb_topology_unconfirmed', usb_devices: [{ usbDeviceId: configured.usbDeviceId }] };
  assert.equal(await discover(paths, { ...options, worker: async () => incomplete }), incomplete);
  await assert.rejects(discover(paths, { ...options, worker: async () => ({ status: 'configuration_candidate', config_candidate: {} }) }), /physical UDID/);
  await assert.rejects(discover(paths, { ...options, worker: async () => ({ status: 'configuration_candidate',
    config_candidate: { ...configured, captureId: '00000000-2222222222222222' } }) }), /remove captureId/);
  const canonical = await discover(paths, { ...options, worker: async () => ({ status: 'configuration_candidate',
    config_candidate: { ...configured, captureId: configured.usbDeviceId, directTouch: true } }) });
  assert.deepEqual(canonical.config_candidate, configured);
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
