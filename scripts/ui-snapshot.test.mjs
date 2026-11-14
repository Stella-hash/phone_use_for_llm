import test from 'node:test';
import assert from 'node:assert/strict';
import {UiInspector} from '../dist/ui.js';
const pkg='org.example.game';
const xml='<?xml version="1.0"?><hierarchy><node class="android.widget.TextView" text="Fixture article" bounds="[0,0][100,100]"/></hierarchy>';
function fixture(patch={}) {
  const calls=[];let checks=0;
  const result={ok:true,packageName:pkg,xml,windowId:4,nodes:1,elapsedMs:2,...patch};
  const adb={getFocusedPackage:()=>{checks++;return pkg},adb:(_, ...args)=>{calls.push(args);return Buffer.from('phone_result_b64='+Buffer.from(JSON.stringify(result)).toString('base64'))}};
  return {calls,adb,result,checks:()=>checks,ui:new UiInspector(adb,1,8000,[pkg])};
}
test('active-root backend is opt-in, owner-focus-bound, and labels its non-idle observation',()=>{
  const f=fixture();assert.equal(f.ui.getElements('synthetic-device')[0].text,'Fixture article');
  assert.equal(f.checks(),2);assert.equal(f.calls.length,1);assert(!f.calls[0].includes('uiautomator'));
  assert.equal(f.ui.getLastCaptureInfo().backend,'helper_active_root');assert.equal(f.ui.getLastCaptureInfo().idleWaited,false);
  const plain=new UiInspector({adb:(_, ...args)=>{assert(args.includes('uiautomator'));return Buffer.from(xml)}});
  assert.equal(plain.getElements('synthetic-device').length,1);assert.equal(plain.getLastCaptureInfo().backend,'uiautomator');
});
test('missing, oversized, partial, foreign or drifting helper results never fall back to another UI tree',()=>{
  for(const patch of [{ok:false},{packageName:'org.other.app'},{xml:''},{nodes:2049},{elapsedMs:9000},{windowId:null},{xml:'x'.repeat(2*1024*1024)}]) {
    const f=fixture(patch);assert.throws(()=>f.ui.getElements('synthetic-device'));assert.equal(f.calls.length,1);assert.equal(f.ui.getLastCaptureInfo(),undefined);
  }
  const f=fixture();let n=0;f.adb.getFocusedPackage=()=>++n===1?pkg:'org.other.app';
  assert.throws(()=>f.ui.getElements('synthetic-device'),/identity/);assert.equal(f.calls.length,1);
  const missing=fixture();missing.adb.adb=()=>Buffer.from('instrumentation missing');assert.throws(()=>missing.ui.getElements('synthetic-device'),/No fallback/);
  const duplicate=fixture();const original=duplicate.adb.adb;duplicate.adb.adb=(...a)=>Buffer.concat([original(...a),original(...a)]);
  assert.throws(()=>duplicate.ui.getElements('synthetic-device'));
});
