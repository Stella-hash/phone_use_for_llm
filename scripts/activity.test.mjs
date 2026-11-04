import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ActivityJournal, archiveValue } from '../dist/activity.js';
import { UiInspector } from '../dist/ui.js';
import { activityReceipt } from '../dist/receipt.js';

fs.mkdirSync(path.resolve(import.meta.dirname, '../.runtime'), { recursive: true });

test('request lookup and execution acknowledgement survive a restart before observation finishes',()=>{
  const folder=fs.mkdtempSync(path.resolve(import.meta.dirname,'../.runtime/receipt-test-'));
  let journal=new ActivityJournal(folder);
  const id=journal.begin('android_tap',{x:10,y:20,label:'private-value'},{private:true},'phone','opaque-request-01');
  assert.equal(activityReceipt(journal.open(id)).execution,'not_started');
  journal.recordExecution(id,'unconfirmed');
  journal.recordExecution(id,'acknowledged');
  assert.throws(()=>journal.begin('android_tap',{},null,'phone','opaque-request-01'),/UNIQUE/);
  journal.close();journal=new ActivityJournal(folder);
  const receipt=activityReceipt(journal.findRequest('opaque-request-01'));
  assert.equal(receipt.eventId,id);assert.equal(receipt.execution,'acknowledged');
  assert.equal(receipt.callOutcome,'uncertain_after_restart');assert.equal(receipt.observation,'unavailable');
  assert.equal(receipt.screenshotAvailable,false);
  assert(!JSON.stringify(journal.open(id)).includes('private-value'));
  assert.equal(journal.findRequest('missing-request'),null);
  assert.equal(activityReceipt({id:1,outcome:'completed'}).execution,'unknown_legacy');
  journal.close();
});

test('activity survives restart and unfinished actions remain uncertain', () => {
  const folder = fs.mkdtempSync(path.resolve(import.meta.dirname, '../.runtime/journal-test-'));
  let journal = new ActivityJournal(folder);
  const first = journal.begin('android_set_text', { text: '中文 📱' }, { actor: 'fixture-operator' }, 'phone');
  journal.finish(first, 'completed', { result: { verified: true } });
  const uncertain = journal.begin('android_tap', { x: 12, y: 34 }, null, 'phone');
  journal.close();
  journal = new ActivityJournal(folder);
  assert.equal(journal.open(first).arguments.text, '[input omitted]');
  assert.equal(journal.open(first).outcome, 'completed');
  assert.equal(journal.open(uncertain).outcome, 'uncertain_after_restart');
  assert.equal(journal.context().recent[0].actor, 'unknown');
  assert.equal(journal.context().recent[1].actor, 'unknown');
  assert.equal(journal.history(1, uncertain)[0].id, first);
  journal.close();
});

test('private calls keep their outcome without archiving input, intent or binary images', () => {
  const folder = fs.mkdtempSync(path.resolve(import.meta.dirname, '../.runtime/private-test-'));
  const journal = new ActivityJournal(folder);
  const id = journal.begin('android_set_text', { text: 'private-value' }, { actor: 'fixture-operator', private: true, intent: 'private-intent' }, 'phone');
  journal.finish(id, 'completed', { result: archiveValue({ content: [{ type: 'text', text: 'private-value' }] }, true) });
  assert(!JSON.stringify(journal.open(id)).includes('private-value'));
  assert(!JSON.stringify(journal.open(id)).includes('private-intent'));
  assert(!JSON.stringify(archiveValue({ selector: 'private-selector-value', mode: 'append', count: 1 }, true)).includes('private-selector-value'));
  assert(!JSON.stringify(archiveValue({ type: 'image', mimeType: 'image/png', data: 'raw-binary' })).includes('raw-binary'));
  journal.close();
});

test('Android XML numeric entities preserve Unicode and newlines without double decoding', () => {
  const xml = '<?xml version="1.0"?><hierarchy><node class="android.widget.EditText" text="你好&#128241;&#10;literal &amp;#10;" bounds="[0,0][200,100]" focused="true" /></hierarchy>';
  const ui = new UiInspector({ adb: () => Buffer.from(xml) });
  assert.equal(ui.getElements('phone')[0].text, '你好📱\nliteral &#10;');
});

test('password input values and accessibility descriptions are both masked', () => {
  const xml = '<?xml version="1.0"?><hierarchy><node class="android.widget.EditText" text="private-password" content-desc="private-description" password="true" bounds="[0,0][200,100]" /></hierarchy>';
  const ui = new UiInspector({ adb: () => Buffer.from(xml) });
  const element = ui.getElements('phone')[0];
  assert.equal(element.password, true);
  assert(!JSON.stringify(element).includes('private-password'));
  assert(!JSON.stringify(element).includes('private-description'));
});
