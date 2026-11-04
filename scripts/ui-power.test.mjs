import test from 'node:test';
import assert from 'node:assert/strict';
import { UiInspector } from '../dist/ui.js';
import { parsePower, readPowerStatus } from '../dist/power.js';
import { withDeadline, remainingTime, DeadlineExceeded } from '../dist/deadline.js';
import { observePhone } from '../dist/observation.js';

const document = body => `<?xml version="1.0"?><hierarchy>${body}</hierarchy>`;
const node = attributes => `<node bounds="[0,0][100,50]" ${attributes}/>`;
const inspector = xml => new UiInspector({ adb: () => Buffer.from(xml), getCurrentApp: () => ({ packageName: 'org.example' }) });

test('raw WebView ID takes precedence over colliding native suffix; native shorthand still works', () => {
  const ui = inspector(document(node('class="android.widget.Button" resource-id="decOpen"')
    + node('class="android.widget.Button" resource-id="org.example:id/decOpen"')
    + node('class="android.widget.Button" resource-id="org.example:id/nativeOnly"')));
  assert.deepEqual(ui.findElements('phone', { resourceId: 'decOpen' }).map(e => e.identifier), ['decOpen']);
  assert.equal(ui.findElements('phone', { resourceId: 'nativeOnly' })[0].identifier, 'org.example:id/nativeOnly');
  assert.equal(ui.findElements('phone', { resourceId: 'org.example:id/decOpen' })[0].identifier, 'org.example:id/decOpen');
});

test('empty editable, focused and password nodes survive; empty layout does not', () => {
  const elements = inspector(document(node('class="android.widget.EditText"')
    + node('class="android.view.View" editable="true"')
    + node('class="android.view.View" focused="true"')
    + node('class="android.view.View" password="true"')
    + node('class="android.widget.FrameLayout"'))).getElements('phone');
  assert.equal(elements.length, 4);
  assert.equal(elements[0].editable, true);
  assert.equal(elements[1].editable, true);
  assert.equal(elements[2].focused, true);
  assert.equal(elements[3].password, true);
});

test('power readings distinguish tenths Celsius, zero, missing and overridden thermal status', () => {
  const data = parsePower('  mWakefulness=Dozing\n  mLastWakeTime=12345 (100 ms ago)',
    ' level: 80\n scale: 100\n temperature: 330\n AC powered: true\n USB powered: false',
    'Thermal Status: 0\nIsStatusOverride: false');
  assert.equal(data.power.wakefulness, 'Dozing');
  assert.equal(data.power.lastWakeUptimeMs, 12345);
  assert.equal(data.battery.temperatureC, 33);
  assert.equal(data.thermal.status, 0);
  assert.equal(data.thermal.statusOverride, false);
  assert.equal(parsePower('', '', '').battery.temperatureC, null);
  assert.equal(parsePower('', '', '').thermal.status, null);
  assert.equal(parsePower('', 'temperature: 0', 'IsStatusOverride: true').battery.temperatureC, 0);
  assert.equal(parsePower('', '', 'Thermal Status: 99').thermal.label, 'unknown');
});

test('power query issues only three dumpsys reads and reports a failed source without inventing it', () => {
  const calls = [];
  const data = readPowerStatus({ shell: (id, ...args) => {
    calls.push(args);
    if (args[1] === 'thermalservice') throw new Error('not available');
    return args[1] === 'power' ? 'mWakefulness=Asleep' : 'temperature: 301';
  } }, 'phone');
  assert.deepEqual(calls, [['dumpsys','power'], ['dumpsys','battery'], ['dumpsys','thermalservice']]);
  assert.equal(data.wakeRequested, false);
  assert.equal(data.battery.temperatureC, 30.1);
  assert.equal(data.thermal.status, null);
  assert.equal(data.errors.length, 1);
});

test('UI retries and nested work cannot reset an inherited deadline', async () => {
  await withDeadline(45, async () => {
    await new Promise(resolve => setTimeout(resolve, 65));
    assert.throws(() => withDeadline(5000, () => remainingTime()), DeadlineExceeded);
  });
  let dumps = 0;
  const ui = new UiInspector({ adb: () => {
    dumps++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35);
    return Buffer.from('null root node returned by UiTestAutomationBridge');
  } }, 10, 20);
  assert.throws(() => ui.getElements('phone'), DeadlineExceeded);
  assert.equal(dumps, 1);
});

test('a failed UI read is not repeated in observation and cannot permit a screenshot', () => {
  const commands = [];
  const observation = observePhone({ shell: (_, ...args) => { commands.push(args); return args.join(' ') === 'dumpsys window policy' ? 'showing=false\nsecure=false' : 'mWakefulness=Awake'; },
    getCurrentApp: () => ({ packageName: 'org.example' }) },
    { getElements: () => { throw new Error('unexpected repeated dump'); } }, 'phone', 1, true, false, null);
  assert.equal(observation.screenshotOmitted, 'UI privacy state unavailable');
  assert(!commands.some(args => args.includes('screencap')));
  assert.equal(observation.errors.length, 1);
});
