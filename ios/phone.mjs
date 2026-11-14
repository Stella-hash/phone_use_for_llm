#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const upstream = Object.freeze({
  url: 'https://github.com/YueChen-C/iPhone-use.git',
  commit: '577d5f2d0ec5831ed6e3e5d9c3ae482ee1dc4f5c',
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function locations(repo = root) {
  const runtime = path.join(repo, '.runtime/iphone-use');
  const source = path.join(runtime, 'source');
  return {
    repo, runtime, source, config: path.join(repo, '.local/iphone-use.json'),
    usbPython: path.join(runtime, 'usb-venv/bin/python'),
    usbRequirements: path.join(repo, 'ios/requirements-usb.txt'),
    usbLocks: Object.fromEntries(['arm64', 'x86_64'].map(architecture =>
      [architecture, path.join(repo, `ios/requirements-usb-macos-${architecture}.lock`)])),
    accessibilityHelper: path.join(repo, 'ios/accessibility/tree.py'),
    touchHelper: path.join(repo, 'ios/coredevice/touch.py'),
    keyboardHelper: path.join(repo, 'ios/coredevice/keyboard.py'),
    usbScreenshotHelper: path.join(repo, 'ios/coredevice/screenshot.py'),
    patches: path.join(repo, 'ios/patches'),
    binary: path.join(source, 'build/iPhoneUse.app/Contents/MacOS/iphone-use'),
    build: path.join(runtime, 'build.json'), pid: path.join(runtime, 'host.json'),
    log: path.join(runtime, 'host.log'), state: path.join(runtime, 'state'),
  };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args, options = {}) {
  const result = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  return (result ?? '').trim();
}
async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${file}: ${error.message}`); }
}
async function optionalJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['captureId', 'port', 'usbDeviceId', 'directTouch', 'directKeyboard'].includes(key))) {
    throw new Error('USB-only config requires usbDeviceId and accepts optional port:7390/directTouch:true/directKeyboard:true. Remove legacy Bluetooth and held-drag settings.');
  }
  if (Object.hasOwn(value, 'port') && value.port !== 7390) throw new Error('This local integration uses port 7390 only.');
  if (typeof value.usbDeviceId !== 'string'
      || !/^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/.test(value.usbDeviceId)
      || ![25, 40].includes(value.usbDeviceId.length)) {
    throw new Error('usbDeviceId must be the exact trusted spare iPhone physical UDID; USB input is required.');
  }
  if (Object.hasOwn(value, 'captureId') && value.captureId !== value.usbDeviceId) {
    throw new Error('Legacy captureId differs from usbDeviceId. An AV capture ID does not verify the USB phone identity. Verify the physical USB UDID with discover, then remove captureId; screenshots and input now share usbDeviceId.');
  }
  for (const route of ['directTouch', 'directKeyboard']) {
    if (Object.hasOwn(value, route) && value[route] !== true) {
      throw new Error(`${route} must be true or omitted; this launcher supports USB-only input.`);
    }
  }
  return { usbDeviceId: value.usbDeviceId, port: 7390,
    directTouch: true, directKeyboard: true };
}

function pythonEnvironment(inherited) {
  // Helpers run in Python isolated mode as well. Do not inherit shell import,
  // startup, user-site or interpreter-home overrides through the native host.
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('PYTHON')));
}

export function childEnvironment(config, paths, inherited = process.env) {
  config = validateConfig(config);
  const env = {
    ...pythonEnvironment(inherited),
    IPHONE_USE_DEVICE_ID: config.usbDeviceId,
    IPHONE_USE_PORT: String(config.port),
    IPHONE_USE_STATE_DIR: paths.state,
  };
  // Managed input is always USB. Parent-shell legacy settings cannot reactivate BLE.
  env.IPHONE_USE_BLUETOOTH_DISABLED = '1';
  delete env.IPHONE_USE_BLUETOOTH_HOST;
  delete env.IPHONE_USE_HELD_DRAG_PROFILE;
  delete env.IPHONE_USE_TRACE_POINTER;
  delete env.IPHONE_USE_ALLOW_USB_TETHER_PREEMPTION;
  env.IPHONE_USE_USB_CLIPBOARD_PYTHON = paths.usbPython;
  env.IPHONE_USE_USB_DEVICE_ID = config.usbDeviceId;
  env.IPHONE_USE_AX_HELPER = paths.accessibilityHelper;
  env.IPHONE_USE_TOUCH_HELPER = paths.touchHelper;
  env.IPHONE_USE_KEYBOARD_HELPER = paths.keyboardHelper;
  env.IPHONE_USE_USB_SCREENSHOT_HELPER = paths.usbScreenshotHelper;
  return env;
}

export function usbLockForProfile(paths, profile) {
  const macOSMajor = Number(profile?.macos?.split('.')[0]);
  if (profile?.implementation !== 'cpython' || profile?.system !== 'Darwin'
      || !Number.isInteger(macOSMajor) || macOSMajor < 14
      || !Array.isArray(profile.version) || profile.version[0] !== 3 || profile.version[1] !== 12
      || !Object.hasOwn(paths.usbLocks, profile.machine)) {
    throw new Error('USB dependency locks support CPython 3.12 on macOS 14+ arm64 or x86_64 only. Recreate the private USB venv with a supported interpreter.');
  }
  return paths.usbLocks[profile.machine];
}

export async function setupUSB(paths, {
  runCommand = run, hosts = otherHosts, inherited = process.env, platform = process.platform,
} = {}) {
  if (platform !== 'darwin') throw new Error('USB dependency locks support macOS only.');
  if (hosts().length) throw new Error('An iPhone Use host is running; stop it before changing the USB Python environment.');
  const environment = Object.fromEntries(Object.entries(pythonEnvironment(inherited)).filter(([key]) =>
    !key.startsWith('UV_') && !key.startsWith('PIP_')
      && !['VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'MACOSX_DEPLOYMENT_TARGET'].includes(key)));
  const options = { env: environment, stdio: 'inherit' };
  const venv = path.dirname(path.dirname(paths.usbPython));
  try { await access(paths.usbPython, constants.X_OK); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await runCommand('uv', ['--no-config', 'venv', '--python', '3.12', venv], options);
  }
  const probe = 'import json,os,platform,sys; print(json.dumps({"implementation":sys.implementation.name,"version":list(sys.version_info[:2]),"system":platform.system(),"macos":platform.mac_ver()[0],"machine":platform.machine(),"prefix":os.path.realpath(sys.prefix),"is_venv":sys.prefix!=sys.base_prefix}))';
  const profile = JSON.parse(await runCommand(paths.usbPython, ['-I', '-B', '-c', probe], { env: environment }));
  const lock = usbLockForProfile(paths, profile);
  if (profile.is_venv !== true || profile.prefix !== await realpath(venv)) {
    throw new Error('Refusing to install USB packages outside the configured private virtual environment.');
  }
  await access(lock);
  await runCommand('uv', ['--no-config', 'pip', 'sync', '--python', paths.usbPython,
    '--require-hashes', '--no-build', '--strict', '--default-index', 'https://pypi.org/simple', lock], options);
  console.log(`Synchronized the hash-locked ${profile.machine} USB dependencies in the private runtime. No phone input was sent.`);
}

async function patchFiles(paths) {
  const names = (await readdir(paths.patches)).filter(name => name.endsWith('.patch')).sort();
  if (!names.length) throw new Error('No ios/patches/*.patch found; refusing an unpatched driver.');
  return names.map(name => path.join(paths.patches, name));
}
async function recipe(paths) {
  const patches = await patchFiles(paths);
  const hash = createHash('sha256').update(upstream.commit);
  for (const file of patches) hash.update(path.basename(file)).update('\0').update(await readFile(file));
  return { patches, fingerprint: hash.digest('hex') };
}

export async function requireBuild(paths) {
  const expected = await recipe(paths);
  const built = await optionalJSON(paths.build);
  if (built?.commit !== upstream.commit || built?.fingerprint !== expected.fingerprint) {
    throw new Error('No current pinned build. Run: node ios/phone.mjs build');
  }
  try { await access(paths.binary, constants.X_OK); }
  catch { throw new Error('Built app executable is missing. Run: node ios/phone.mjs build'); }
  return expected;
}

export function discoveryEnvironment(paths, inherited = process.env) {
  const env = { ...pythonEnvironment(inherited), IPHONE_USE_BLUETOOTH_DISABLED: '1', IPHONE_USE_STATE_DIR: paths.state };
  for (const key of ['IPHONE_USE_DEVICE_ID', 'IPHONE_USE_USB_DEVICE_ID', 'IPHONE_USE_BLUETOOTH_HOST',
    'IPHONE_USE_HELD_DRAG_PROFILE', 'IPHONE_USE_TRACE_POINTER', 'IPHONE_USE_ALLOW_USB_TETHER_PREEMPTION',
    'IPHONE_USE_USB_CLIPBOARD_PYTHON', 'IPHONE_USE_AX_HELPER', 'IPHONE_USE_TOUCH_HELPER', 'IPHONE_USE_KEYBOARD_HELPER',
    'IPHONE_USE_USB_SCREENSHOT_HELPER']) {
    delete env[key];
  }
  return env;
}

export function runDiscoveryWorker(command, args, { env = process.env, timeoutMs = 15000, cleanupMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', failure, killTimer;
    const cancel = message => {
      if (failure) return;
      failure = message;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), cleanupMs);
    };
    const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [
      signal, () => cancel(`Discovery interrupted by ${signal}; USB cleanup may be pending.`),
    ]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const timer = setTimeout(() => cancel('Discovery timed out; USB cleanup may be pending. Inspect the result before retrying.'), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(killTimer);
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    };
    child.stdout.on('data', chunk => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 1024 * 1024) cancel('Discovery output exceeded its bound; USB cleanup may be pending.');
      else stdout += chunk;
    });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length); });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      let result;
      try { result = JSON.parse(stdout); } catch { /* Report malformed/missing output explicitly below. */ }
      if (failure) return reject(new Error(`${failure}${result?.cleanup ? ` Worker cleanup: ${result.cleanup}.` : ''}`));
      if (signal || ![0, 2].includes(code) || result?.schema_version !== 1 || typeof result.status !== 'string') {
        return reject(new Error(`Discovery failed (${signal ?? code}); no configuration was written.${stderr.trim() ? ` ${stderr.trim()}` : ''}`));
      }
      if ((code === 0) !== (result.status === 'configuration_candidate')) {
        return reject(new Error('Discovery returned inconsistent status; no configuration was written.'));
      }
      resolve(result);
    });
  });
}

export async function discover(paths, { checkBuild = requireBuild, hosts = otherHosts, worker = runDiscoveryWorker } = {}) {
  await checkBuild(paths);
  if (hosts().length) throw new Error('An iPhone Use host is running; stop it before discovery. No USB configuration was changed.');
  const result = await worker(paths.binary, ['--discover-usb-setup'], { env: discoveryEnvironment(paths) });
  if (result.status === 'configuration_candidate') {
    const config = validateConfig(result.config_candidate);
    return { ...result, config_candidate: { usbDeviceId: config.usbDeviceId, port: config.port } };
  }
  return result;
}

// A PID alone is insufficient: stop also checks the recorded start time and executable.
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    return {
      pid,
      started: run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']),
      executable: run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm=']),
    };
  } catch { return null; }
}
export function isOwnedProcess(record, current, binary) {
  return Boolean(record && current && record.pid === current.pid
    && record.started === current.started && record.executable === binary
    && current.executable === binary);
}
function otherHosts() {
  const rows = run('/bin/ps', ['-ww', '-axo', 'pid=,comm=']).split('\n');
  return rows.flatMap(row => {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || path.basename(match[2]) !== 'iphone-use') return [];
    const pid = Number(match[1]);
    try {
      const command = run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
      // Native stdio clients do not own capture/Bluetooth and can coexist with one host.
      return command === `${match[2]} mcp` ? [] : [pid];
    } catch { return []; }
  });
}
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`127.0.0.1:${port} is occupied; no process was stopped.`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}
function ownsListener(pid, port) {
  try {
    const output = run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn']);
    return output.split('\n').includes(`n127.0.0.1:${port}`);
  } catch { return false; }
}
async function readHostStatus(config) {
  const response = await fetch(`http://127.0.0.1:${config.port}/status?wake=0`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Passive host status returned HTTP ${response.status}`);
  return response.json();
}
export function verifyHostSelection(status, config) {
  validateConfig(config);
  if (status?.bluetoothEnabled !== false || !Array.isArray(status.bluetoothHosts) || status.bluetoothHosts.length !== 0) {
    throw new Error('Running driver does not confirm USB-only mode with Bluetooth disabled and no Bluetooth hosts; no MCP client was launched.');
  }
  if (status?.directTouch !== true) {
    throw new Error('Running driver has a different directTouch setting; restart the managed host before MCP use.');
  }
  if (status?.directKeyboard !== true) {
    throw new Error('Running driver has a different directKeyboard setting; restart the managed host before MCP use.');
  }
}

async function exclusive(paths, action) {
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const lockPath = path.join(paths.runtime, 'lifecycle.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another lifecycle operation holds ${lockPath}. If it crashed, inspect and remove only that stale lock.`);
  }
  await lock.writeFile(`${process.pid}\n`);
  try { return await action(); }
  finally { await lock.close(); await rm(lockPath); }
}

async function build(paths) {
  if (otherHosts().length) throw new Error('An iPhone Use host is running; stop it before rebuilding its executable.');
  const { patches, fingerprint } = await recipe(paths);
  let sourceExists = true;
  try { await access(paths.source); } catch { sourceExists = false; }
  if (!sourceExists) {
    run('git', ['clone', '--no-checkout', '--filter=blob:none', '--depth=1', upstream.url, paths.source], { stdio: 'inherit' });
    run('git', ['fetch', '--depth=1', 'origin', upstream.commit], { cwd: paths.source, stdio: 'inherit' });
    run('git', ['checkout', '--detach', upstream.commit], { cwd: paths.source, stdio: 'inherit' });
  }
  const git = (...args) => run('git', args, { cwd: paths.source });
  if (git('rev-parse', 'HEAD') !== upstream.commit || git('remote', 'get-url', 'origin') !== upstream.url) {
    throw new Error('Dependency checkout has a different origin or HEAD; it was left untouched.');
  }
  // Derive the expected patched Git tree in a temporary index. Never reset user edits.
  const scratch = await mkdtemp(path.join(paths.runtime, 'index-'));
  let expectedTree;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    const indexedGit = (...args) => run('git', args, { cwd: paths.source, env });
    indexedGit('read-tree', upstream.commit);
    indexedGit('apply', '--cached', ...patches);
    expectedTree = indexedGit('write-tree');
  } finally { await rm(scratch, { recursive: true }); }
  const matches = tree => {
    try { git('diff', '--quiet', tree, '--'); return !git('ls-files', '--others', '--exclude-standard'); }
    catch { return false; }
  };
  if (!matches(expectedTree)) {
    if (!matches(upstream.commit)) throw new Error('Dependency has unexpected edits or older patches; no files were reset.');
    git('apply', '--index', ...patches);
  }
  if (!matches(expectedTree)) throw new Error('Dependency does not match the pinned source plus current patches.');
  await rm(paths.build, { force: true });
  run('/bin/zsh', ['scripts/build-app.sh'], {
    cwd: paths.source, stdio: 'inherit',
    env: { ...process.env, CONFIG: 'release', BUILD_ARCH: 'native', CODESIGN_IDENTITY: '-' },
  });
  await access(paths.binary, constants.X_OK);
  await atomicJSON(paths.build, { commit: upstream.commit, fingerprint, builtAt: new Date().toISOString() });
  console.log(`Built pinned driver: ${paths.binary}`);
}

async function start(paths, config) {
  await requireBuild(paths);
  if (config.usbDeviceId) {
    try { await access(paths.usbPython, constants.X_OK); }
    catch { throw new Error('The USB interpreter is missing. Run: node ios/phone.mjs setup-usb'); }
  }
  const record = await optionalJSON(paths.pid);
  if (record && isOwnedProcess(record, processIdentity(record.pid), paths.binary)) {
    if (record.config !== JSON.stringify(config)) throw new Error('Host uses an older config; stop it before starting with the new config.');
    if (!ownsListener(record.pid, config.port)) throw new Error('Managed host is running but its loopback listener is not ready; inspect its log.');
    verifyHostSelection(await readHostStatus(config), config);
    console.log(`Already running: pid ${record.pid}, http://127.0.0.1:${config.port}`);
    return;
  }
  const hosts = otherHosts();
  if (hosts.length) throw new Error(`An unmanaged iPhone Use host is running (pid ${hosts.join(', ')}); no duplicate was launched.`);
  await assertPortFree(config.port);
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const log = await open(paths.log, 'a', 0o600);
  const child = spawn(paths.binary, ['--resident-quiet'], {
    cwd: paths.runtime, env: childEnvironment(config, paths), detached: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  let identity;
  try {
    identity = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve(processIdentity(child.pid)));
    });
  } finally { await log.close(); }
  child.unref();
  if (!identity || identity.executable !== paths.binary) throw new Error(`Host did not remain running. See ${paths.log}`);
  await atomicJSON(paths.pid, { ...identity, config: JSON.stringify(config) });
  for (let i = 0; i < 50; i++) {
    if (!isOwnedProcess(identity, processIdentity(child.pid), paths.binary)) throw new Error(`Host exited. See ${paths.log}`);
    if (ownsListener(child.pid, config.port)) {
      verifyHostSelection(await readHostStatus(config), config);
      console.log(`Host running: pid ${child.pid}, http://127.0.0.1:${config.port}\nLog: ${paths.log}`);
      return;
    }
    await sleep(200);
  }
  throw new Error(`Host started but its loopback listener is not ready. Inspect ${paths.log}; use stop to end this owned host.`);
}

async function stop(paths) {
  const record = await optionalJSON(paths.pid);
  if (!record) { console.log('No managed host is recorded.'); return; }
  const current = processIdentity(record.pid);
  if (!current) { await rm(paths.pid); console.log('Recorded host has exited; removed its stale record.'); return; }
  if (!isOwnedProcess(record, current, paths.binary)) throw new Error('Recorded PID belongs to a different process; no signal was sent.');
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!isOwnedProcess(record, processIdentity(record.pid), paths.binary)) {
      await rm(paths.pid); console.log('Stopped the managed iPhone Use host.'); return;
    }
    await sleep(200);
  }
  throw new Error('Host did not exit after SIGTERM; it was not force-killed. Inspect its log.');
}

async function status(paths, config) {
  const record = await optionalJSON(paths.pid);
  const owned = record && isOwnedProcess(record, processIdentity(record.pid), paths.binary);
  const result = { running: Boolean(owned), pid: owned ? record.pid : null, origin: `http://127.0.0.1:${config.port}` };
  if (owned && ownsListener(record.pid, config.port)) {
    try {
      // wake=0 skips upstream capture wake/recovery; no screenshot or input is requested.
      result.driver = await readHostStatus(config);
      verifyHostSelection(result.driver, config);
    } catch (error) { result.observationError = error.message; }
  }
  console.log(JSON.stringify(result, null, 2));
}

export async function main(args = process.argv.slice(2), paths = locations()) {
  const command = args[0];
  if (args.length !== 1 || !['build', 'setup-usb', 'discover', 'start', 'status', 'stop', 'mcp'].includes(command)) {
    throw new Error('Usage: node ios/phone.mjs build|setup-usb|discover|start|status|stop|mcp');
  }
  if (process.platform !== 'darwin') throw new Error('The iPhone driver requires macOS.');
  if (command === 'build') return exclusive(paths, () => build(paths));
  if (command === 'setup-usb') return exclusive(paths, () => setupUSB(paths));
  if (command === 'stop') return exclusive(paths, () => stop(paths));
  if (command === 'discover') {
    const result = await exclusive(paths, () => discover(paths));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'configuration_candidate') process.exitCode = 2;
    return;
  }
  const config = validateConfig(await json(paths.config));
  if (command === 'start') return exclusive(paths, () => start(paths, config));
  if (command === 'status') return status(paths, config);
  await requireBuild(paths);
  const record = await optionalJSON(paths.pid);
  if (!record || !isOwnedProcess(record, processIdentity(record.pid), paths.binary)
      || record.config !== JSON.stringify(config) || !ownsListener(record.pid, config.port)) {
    throw new Error('The configured managed host is not ready. Run: node ios/phone.mjs start');
  }
  verifyHostSelection(await readHostStatus(config), config);
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  // No build or host launch on MCP initialization. Native MCP owns JSON-RPC and images.
  const child = spawn(paths.binary, ['mcp'], { env: childEnvironment(config, paths), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`iphone-use: ${error.message}`); process.exitCode = 1; });
}
