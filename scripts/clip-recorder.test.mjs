import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('./clip-recorder.py', import.meta.url));
const python = process.platform === 'linux'
  ? spawnSync('python3', ['-c', 'import pty'], { timeout: 2000, encoding: 'utf8' })
  : null;
const skip = process.platform !== 'linux' ? 'Linux PTY recorder test; not available on this host'
  : python.error || python.status !== 0 ? 'python3 with pty is unavailable' : false;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('real PTY wrapper streams startup and reaps its SIGINT-ignoring recorder', { skip, timeout: 10000 }, async () => {
  // Signal handling is installed before the ready line; an ordinary default
  // SIGINT exit cannot accidentally satisfy the escalation/reaping check.
  const fixture = `
    process.on('SIGINT', () => process.stdout.write('FIXTURE_SIGINT_IGNORED\\n'));
    process.stdout.write('FIXTURE_PID=' + process.pid + ' TTY=' + Number(process.stdout.isTTY === true) + '\\n');
    process.stdout.write('Recording started to matroska file: fixture.mkv\\n');
    setInterval(() => {}, 1000);
  `;
  const recorder = spawn('python3', [wrapper, process.execPath, '-e', fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  recorder.stdin.end();
  let output = '', error, exited = false, childPid;
  const receive = chunk => { output = (output + chunk.toString()).slice(-16384); };
  recorder.stdout.on('data', receive);
  recorder.stderr.on('data', receive);
  recorder.on('error', value => { error = value; });
  const closed = new Promise(resolve => recorder.on('close', (code, signal) => {
    exited = true; resolve({ code, signal });
  }));
  try {
    const readyBy = performance.now() + 4000;
    while (!output.includes('Recording started to matroska file:')) {
      if (error) throw error;
      assert.equal(exited, false, `Wrapper exited before live startup: ${output}`);
      assert(performance.now() < readyBy, `Wrapper did not stream startup: ${output}`);
      await pause(10);
    }
    const identity = output.match(/FIXTURE_PID=(\d+) TTY=(\d)/);
    assert(identity, `Fixture identity missing: ${output}`);
    childPid = Number(identity[1]);
    assert.equal(identity[2], '1', 'Recorder stdout must be attached to the PTY');
    assert.equal(exited, false, 'Startup must be visible while the wrapper is running');
    assert.equal(alive(childPid), true, 'Startup must be visible while the recorder is running');

    const stoppedAt = performance.now();
    assert.equal(recorder.kill('SIGINT'), true);
    const result = await bounded(closed, 2000, 'Wrapper did not exit within the parent cleanup grace period');
    assert(performance.now() - stoppedAt < 2000, 'Wrapper must exit before the parent 2500 ms escalation');
    assert.match(output, /FIXTURE_SIGINT_IGNORED/, 'Wrapper must forward SIGINT before escalating');
    assert.equal(result.signal, null, 'Wrapper should reap the recorder and exit itself');
    assert.notEqual(result.code, 0, 'Forced recorder termination must not be reported as success');
    assert.equal(alive(childPid), false, 'Recorder PID must be gone, including any unreaped zombie');
  } finally {
    // These are cleanup only; assertions above establish success before any
    // direct fixture kill. Never signal unrelated processes or process groups.
    childPid ??= Number(output.match(/FIXTURE_PID=(\d+)/)?.[1]) || undefined;
    if (!exited) {
      recorder.kill('SIGINT');
      await bounded(closed, 2000, 'Cleanup grace expired').catch(() => {});
    }
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
    if (!exited) {
      recorder.kill('SIGKILL');
      await bounded(closed, 1000, 'Wrapper cleanup failed');
    }
  }
});
