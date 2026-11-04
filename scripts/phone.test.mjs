import { fixtureOwner } from './fixtures/owner.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('HTTP adapter keeps both status paths asleep; explicit wake and sleep preserve their semantics and journal', async t => {
  fs.mkdirSync(path.resolve('.runtime'), { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('.runtime/adapter-test-'));
  const owner = fixtureOwner(directory);
  const trace = path.join(directory, 'commands.jsonl');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/fake-adb.mjs', 'dist/phone.js'], {
    windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env,
      PHONE_SECURITY_FILE: owner.file, PHONE_DEVICE: 'synthetic-device', PHONE_PORT: String(port), PHONE_DATA_DIR: directory,
      PHONE_TEST_TRACE: trace, PHONE_SUMMARY_API_KEY: '', PHONE_SUMMARY_KEY_FILE: '' },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'phone-regression-test', version: '1.0.0' });
  t.after(async () => { await client.close(); child.kill(); });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { const response = await fetch(endpoint + '/healthz', {headers: owner.headers}); assert(response.ok); break; }
    catch { if (attempt > 400 || child.exitCode !== null) throw new Error('Fixture startup failed or exceeded 20 seconds: ' + stderr); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp'), {requestInit: {headers: owner.headers}}));
  owner.wrap(client);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return result.content.filter(item => item.type === 'text').map(item => { try { return JSON.parse(item.text); } catch { return item.text; } });
  };
  const catalog = (await client.listTools()).tools;
  assert.equal(catalog.length, 26);
  assert.equal(catalog.find(tool => tool.name === 'android_activity_reading').annotations.readOnlyHint, true);
  assert.equal(catalog.find(tool => tool.name === 'android_chrome_read').annotations.readOnlyHint, true);
  assert.equal(catalog.find(tool => tool.name === 'android_power_status').annotations.readOnlyHint, true);
  assert.equal(catalog.find(tool => tool.name === 'android_list_elements').annotations.readOnlyHint, true);
  for (const name of ['android_power_status', 'android_device_info']) {
    const [data, , continuity] = await call(name);
    assert.equal(data.wakeRequested, false);
    assert.equal(data.power.wakefulness, 'Dozing');
    assert.equal(data.battery.temperatureC, 33);
    assert.equal(continuity.phoneActivity.latestPhoneEventId, 0);
  }
  let commands = fs.readFileSync(trace, 'utf8');
  assert(!/KEYCODE_WAKEUP|dismiss-keyguard|uiautomator|screencap|instrument/.test(commands));
  const sleepyChrome = await client.callTool({name:'android_chrome_read',arguments:{}});
  assert(sleepyChrome.isError);
  assert.match(sleepyChrome.content[0].text, /SCREEN_ASLEEP/);
  commands = fs.readFileSync(trace, 'utf8');
  assert(!/KEYCODE_WAKEUP|dismiss-keyguard|uiautomator|screencap|instrument|forward/.test(commands));
  const [history] = await call('android_activity_history');
  assert(history.entries.filter(e => ['android_device_info','android_power_status'].includes(e.tool)).every(e => e.kind === 'status'));
  const [awake] = await call('android_device_info', { wake: true });
  assert.equal(awake.wakeRequested, true);
  assert.equal(awake.power.wakefulness, 'Awake');
  await call('android_press_key', { key: 'KEYCODE_SLEEP' });
  const before = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).length;
  await call('android_press_key', { key: 'KEYCODE_SLEEP' });
  commands = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).slice(before).join('\n');
  assert(!/KEYCODE_WAKEUP|dismiss-keyguard|uiautomator|screencap|instrument/.test(commands));
  const [asleep] = await call('android_device_info');
  assert.equal(asleep.power.wakefulness, 'Dozing');
  assert.equal(asleep.wakeRequested, false);
  const stillAsleep = await client.callTool({ name: 'android_list_elements', arguments: {} });
  assert(stillAsleep.isError); assert.match(stillAsleep.content[0].text, /SCREEN_ASLEEP/);
  const [priorHistory] = await call('android_activity_history');
  const sourceId = priorHistory.entries.find(e => e.tool === 'android_device_info').id;
  const traceBeforeReading = fs.readFileSync(trace, 'utf8');
  const [reading, readingContinuity] = await call('android_activity_reading', {eventId: sourceId});
  assert.equal(reading.needs_review, true);
  assert.equal(reading.issue, 'text_unavailable');
  assert.deepEqual(reading.new_text, []);
  assert.equal(fs.readFileSync(trace, 'utf8'), traceBeforeReading, 'reading stored text must not call ADB');
  const [readingEvent] = await call('android_activity_open', {eventId: readingContinuity.phoneActivity.eventId});
  assert.equal(readingEvent.kind, 'history');
  assert.equal(readingEvent.result.historyRead, true);
  const missingReading = await client.callTool({name:'android_activity_reading',arguments:{eventId:99999999}});
  assert(missingReading.isError);
  assert.equal(fs.readFileSync(trace, 'utf8'), traceBeforeReading);
  await call('android_device_info', {wake:true});
  const [elements] = await call('android_list_elements');
  assert.equal(elements.elements[0].editable, true);
  assert.equal(elements.elements[0].focused, true);
  const [gesture, , gestureContinuity] = await call('android_gesture', { points: [{x:10,y:10},{x:20,y:20}], context:{private:true} });
  assert.equal(gesture.pointerReleased, true);
  const [event] = await call('android_activity_open', { eventId: gestureContinuity.phoneActivity.eventId });
  assert.equal(event.tool, 'android_gesture');
  assert.equal(event.outcome, 'completed');
  assert.equal(event.observation.screenshotOmitted, 'private call');
  const beforeChrome=fs.readFileSync(trace,'utf8').split('\n').filter(Boolean).length;
  for(const privateCall of [false,true]) {
    const result=await client.callTool({name:'android_chrome_read',arguments:{expectedUrl:'https://fixture.example/page',context:{private:privateCall}}});
    assert(!result.isError,JSON.stringify(result));
    assert(!result.content.some(c=>c.type==='image'));
    const data=JSON.parse(result.content[0].text);assert.match(data.text,/中文/);
    assert(!JSON.stringify(result).includes('FAKE_PRIVATE_VALUE'));
    const eventId=result.content.filter(c=>c.type==='text').map(c=>JSON.parse(c.text)).find(c=>c.phoneActivity).phoneActivity.eventId;
    const [saved]=await call('android_activity_open',{eventId});
    if(privateCall){assert(!JSON.stringify(saved).includes('fixture.example'));assert(!JSON.stringify(saved).includes('Visible Chinese'));}
    else assert(JSON.stringify(saved).includes('Visible Chinese'));
  }
  const chromeCommands=fs.readFileSync(trace,'utf8').split('\n').filter(Boolean).slice(beforeChrome).join('\n');
  assert(!/KEYCODE_WAKEUP|dismiss-keyguard|uiautomator|screencap|instrument/.test(chromeCommands));

  const traceRows=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(row=>JSON.parse(row));
  const invalidStart=traceRows().length;
  for (const value of [-1,1.5,5001,'2000',null]) {
    const invalid=await client.callTool({name:'android_tap',arguments:{x:10,y:10,observeAfterMs:value}});
    assert(invalid.isError);
  }
  const unsupported=await client.callTool({name:'android_power_status',arguments:{observeAfterMs:0}});
  assert(unsupported.isError); assert.equal(traceRows().length,invalidStart);
  assert.equal(catalog.find(t=>t.name==='android_tap').inputSchema.properties.observeAfterMs.maximum,5000);
  assert.equal(catalog.find(t=>t.name==='android_power_status').inputSchema.properties.observeAfterMs,undefined);

  const delayedStart=traceRows().length;
  const delayed=await client.callTool({name:'android_tap',arguments:{x:10,y:20,observeAfterMs:50}});
  assert(!delayed.isError); assert.equal(delayed.content.filter(c=>c.type==='image').length,1);
  const delayedTexts=delayed.content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return c.text;}});
  const observed=delayedTexts.find(c=>c.phoneObservation).phoneObservation;
  assert.equal(observed.delay.status,'elapsed'); assert(observed.delay.elapsedMs>=45);
  assert.equal(observed.screenshot.returnedInline,true);
  const delayedRows=traceRows().slice(delayedStart);
  const taps=delayedRows.filter(r=>r.args[0]==='input'&&r.args[1]==='tap');
  const captures=delayedRows.filter(r=>r.args[0]==='exec-out'&&r.args[1]==='screencap');
  assert.equal(taps.length,1); assert.equal(captures.length,1);
  assert(captures[0].at-taps[0].at>=45,'the single returned frame must be captured after the delay');
  const delayedId=delayedTexts.find(c=>c.phoneActivity).phoneActivity.eventId;
  const [delayedSaved]=await call('android_activity_open',{eventId:delayedId});
  assert.equal(delayedSaved.arguments.observeAfterMs,50);
  assert.deepEqual(delayedSaved.observation.delay,observed.delay);

  const failureStart=traceRows().length;
  const failed=await client.callTool({name:'android_tap',arguments:{x:99,y:20,observeAfterMs:500}});
  assert(failed.isError);
  const failureObservation=failed.content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return {};}}).find(c=>c.phoneObservation).phoneObservation;
  assert.equal(failureObservation.delay.status,'action_failed');
  assert.equal(failureObservation.delay.elapsedMs,0);
  assert.equal(traceRows().slice(failureStart).filter(r=>r.args[0]==='input'&&r.args[1]==='tap').length,1);

  const queueStart=traceRows().length;
  const concurrent=await Promise.all([
    client.callTool({name:'android_tap',arguments:{x:11,y:20,observeAfterMs:45}}),
    client.callTool({name:'android_tap',arguments:{x:22,y:20}}),
  ]);
  assert(concurrent.every(r=>!r.isError));
  const queueRows=traceRows().slice(queueStart);
  const queueTaps=queueRows.filter(r=>r.args[0]==='input'&&r.args[1]==='tap');
  const queueCaptures=queueRows.filter(r=>r.args[0]==='exec-out'&&r.args[1]==='screencap');
  assert.equal(queueTaps.length,2); assert.equal(queueCaptures.length,2);
  assert(queueTaps[1].at>=queueCaptures[0].at,'another input must not interleave with a pending observation');
});
