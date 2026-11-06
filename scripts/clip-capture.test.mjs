import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { recordWindow, clipCaptureSchema, parseInputDisplay } from '../dist/clip-capture.js';
import { overviewIndices } from '../dist/clip-tools.js';
import { withDeadline } from '../dist/deadline.js';

function recorder({complete=true,early=false}={}) {
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.signals=[];child.closed=false;
  child.finish=()=>{if(!child.closed){child.closed=true;child.emit('close',0,null);}};
  child.kill=signal=>{child.signals.push(signal);if(complete)child.stdout.write('Recording complete to matroska file: own.mkv\n');child.finish();return true;};
  setImmediate(()=>{if(early)child.finish();else child.stdout.write('Recording started to matroska file: own.mkv\n');});
  return child;
}
function target() {
  fs.mkdirSync('.runtime',{recursive:true});const dir=fs.mkdtempSync(path.resolve('.runtime/clip-recorder-test-'));
  const file=path.join(dir,'source.mkv');fs.writeFileSync(file,'fixture');return file;
}
test('recorder confirms open, attempts input once and stops only its own process',async()=>{
  const child=recorder();let inputs=0;
  const result=await withDeadline(25000,()=>recordWindow('fixture',[],target(),30,async alive=>{await alive();inputs++;return 'ack';},()=>child));
  assert.equal(inputs,1);assert.deepEqual(child.signals,['SIGINT']);assert.equal(result.inputResult,'ack');
  assert.equal(result.firstFrameBeforeInputVerified,false);assert.equal(result.actionVideoPtsMs,null);
});
test('early recorder exit and insufficient input budget never inject input',async()=>{
  for(const early of [true,false]) {
    const child=recorder({early});let inputs=0;
    await assert.rejects(()=>withDeadline(early?25000:10000,()=>recordWindow('fixture',[],target(),30,()=>{inputs++;},()=>child)),/BEFORE_INPUT|INSUFFICIENT_ACTION_BUDGET/);
    assert.equal(inputs,0);assert(child.closed);
  }
});
test('exit during synchronous input guard is observed before tap; guard failure cleans up without replay',async()=>{
  for(const close of [true,false]) {
    const child=recorder();let taps=0;
    await assert.rejects(()=>withDeadline(25000,()=>recordWindow('fixture',[],target(),30,async alive=>{
      if(close){setTimeout(()=>child.finish(),0);const until=performance.now()+20;while(performance.now()<until){}await alive();}
      else throw new Error('GUARD_FAILED');
      taps++;
    },()=>child)),/STOPPED_BEFORE_INPUT|GUARD_FAILED/);
    assert.equal(taps,0);assert(child.closed);
  }
});
test('failed finalization does not replay acknowledged input',async()=>{
  const child=recorder({complete:false});let inputs=0;
  await assert.rejects(()=>withDeadline(25000,()=>recordWindow('fixture',[],target(),30,()=>{inputs++;},()=>child)),/NOT_FINALIZED/);
  assert.equal(inputs,1);assert(child.closed);
});
test('clip schemas bound duration and native geometry; overview samples timestamps rather than assumed FPS',()=>{
  const base={expectedPackage:'fixture.game',expectedDisplay:{width:100,height:200}};
  assert.throws(()=>clipCaptureSchema.parse({...base,tap:{x:100,y:50}}));
  assert.throws(()=>clipCaptureSchema.parse({...base,durationMs:5001}));
  const frames=[0,10,20,30,40,50,1000].map((relativeMs,index)=>({relativeMs,index}));
  assert.deepEqual(overviewIndices({frames,video:{spanMs:1000}}),[0,5,6]);
});
test('clip guard reads rotated input coordinates and rejects ambiguous or absent active displays',()=>{
  const view='Viewport INTERNAL: displayId=0, uniqueId=local:test, orientation=1, logicalFrame=[0, 0, 3200, 1440], deviceSize=[3200, 1440], isActive=[1]';
  assert.deepEqual(parseInputDisplay(view+'\n'+view),{width:3200,height:1440,rotation:1});
  assert.deepEqual(parseInputDisplay(view.replace('orientation=1','orientation=3')),{width:3200,height:1440,rotation:3});
  assert.throws(()=>parseInputDisplay(view+'\n'+view.replace('orientation=1','orientation=0')),/UNAVAILABLE/);
  assert.throws(()=>parseInputDisplay(view.replace('displayId=0','displayId=10')),/UNAVAILABLE/);
  assert.throws(()=>parseInputDisplay(view.replace('isActive=[1]','isActive=[0]')),/UNAVAILABLE/);
  assert.throws(()=>parseInputDisplay('Physical size: 1440x3200'),/UNAVAILABLE/);
});
