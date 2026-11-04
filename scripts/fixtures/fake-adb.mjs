// Loaded only by the integration test's --import option, never the service itself.
import fs from 'node:fs';
import { AdbClient } from '../../dist/adb.js';
import { ChromeConnection } from '../../dist/chrome.js';
import { fixtureRpc } from './chrome-snapshot.mjs';
const trace = process.env.PHONE_TEST_TRACE;
const record = (method, args) => fs.appendFileSync(trace, JSON.stringify({ method, args, at: performance.now() }) + '\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC4sAAAAASUVORK5CYII=', 'base64');
let awake = process.env.PHONE_TEST_AWAKE === '1';
let invalidCapture = false;
let inputCompleted = false;
AdbClient.prototype.adb = function (device, ...args) {
  record('adb', args);
  if (args[0] === 'get-state') return Buffer.from('device\n');
  if (args[0] === 'forward') return Buffer.from(args[1] === 'tcp:0' ? '31337' : '');
  if (args.includes('uiautomator')) return Buffer.from('<?xml version="1.0"?><hierarchy><node class="android.widget.EditText" focused="true" bounds="[0,0][100,50]"/></hierarchy>');
  if (args[0] === 'exec-out' && ['cat', 'screencap'].includes(args[1])) return invalidCapture ? Buffer.from('invalid capture') : png;
  throw new Error('Unexpected fake ADB command');
};
AdbClient.prototype.shell = function (device, ...args) {
  record('shell', args);
  if (args.join(' ') === 'dumpsys power') return `mWakefulness=${awake ? 'Awake' : 'Dozing'}\nmLastWakeTime=12345`;
  if (args.join(' ') === 'dumpsys battery') return 'level: 100\nscale: 100\ntemperature: 330';
  if (args.join(' ') === 'dumpsys thermalservice') return 'Thermal Status: 0\nIsStatusOverride: false';
  if (args.join(' ') === 'dumpsys window policy') return process.env.PHONE_TEST_LOCK === 'unknown' ? '' : `showing=${process.env.PHONE_TEST_LOCK === 'locked' || (inputCompleted && process.env.PHONE_TEST_LOCK_AFTER_INPUT === '1')}\nsecure=false`;
  if (args[0] === 'input') {
    if (args[1] === 'text') throw new Error('synthetic raw input failure ' + args[2]);
    if (args[1] === 'tap') invalidCapture = String(args[2]) === '88';
    if (args[1] === 'tap' && String(args[2]) === '99') throw new Error('Synthetic input failure');
    inputCompleted = true;
    if (args[2] === 'KEYCODE_WAKEUP') awake = true;
    if (args[2] === 'KEYCODE_SLEEP') awake = false;
    return '';
  }
  if (args[0] === 'mkdir' || args[0] === 'screencap' || (args[0] === 'am' && args[1] === 'broadcast')) return '';
  if (args[0] === 'content' && args[1] === 'query') return args.at(-1);
  if (args[0] === 'wm') return '';
  if (args[0] === 'am' && args.at(-1) === 'dev.gc.agentphone.helper/.GestureInstrumentation')
    return 'phone_result_b64=' + Buffer.from(JSON.stringify({ ok:true, pointerReleased:true, terminalAction:'up', acceptedMoves:4 })).toString('base64');
  throw new Error('Unexpected fake shell command');
};
AdbClient.prototype.getScreenSize = () => ({ width: 100, height: 200 });
AdbClient.prototype.getCurrentApp = () => ({ packageName: process.env.PHONE_TEST_PACKAGE || 'com.android.chrome', activity: '.Main' });
AdbClient.prototype.getFocusedPackage = () => inputCompleted && process.env.PHONE_TEST_FOCUS_AFTER_INPUT
  ? process.env.PHONE_TEST_FOCUS_AFTER_INPUT : process.env.PHONE_TEST_PACKAGE || 'com.android.chrome';
AdbClient.prototype.getProp = () => 'test-device';
AdbClient.prototype.getOrientation = () => 'portrait';
const realFetch=globalThis.fetch;
globalThis.fetch=(url,...args)=>String(url)==='http://127.0.0.1:31337/json/list'
  ? Promise.resolve(new Response(JSON.stringify([{id:'fixture',type:'page',url:'https://fixture.example/page'}]))) : realFetch(url,...args);
ChromeConnection.connect=async()=>({close:()=>record('cdp',['close']),call:async(method,params)=>{record('cdp',[method]);return fixtureRpc(method,params);}});
