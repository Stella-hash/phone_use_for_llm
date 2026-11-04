import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { normalizeChromeSnapshot } from '../dist/chrome-snapshot.js';
import { captureChromePage, chromeReadSchema, ChromeConnection } from '../dist/chrome.js';
import { withDeadline } from '../dist/deadline.js';
import { chromeFixture, fixtureRpc } from './fixtures/chrome-snapshot.mjs';

const normalize=(fixture,limits={maxChars:12000,maxElements:100})=>normalizeChromeSnapshot(fixture.snapshot,fixture.ax,fixture.metrics,'main','https://fixture.example/page',limits);
test('Chrome snapshot preserves blank controls, source semantics and CSS bounds while excluding password/hidden/frame content',()=>{
  const data=normalize(chromeFixture()), encoded=JSON.stringify(data);
  assert.match(data.text,/中文/);
  for(const marker of ['FAKE_PRIVATE_VALUE','HIDDEN_MARKER','OFFSCREEN_MARKER','CHILD_MARKER'])assert(!encoded.includes(marker),marker);
  const blank=data.elements.find(e=>e.tag==='input'&&e.identifier===null);
  assert.equal(blank.value,'');assert.equal(blank.name,'');assert.equal(blank.role,'textbox');
  assert.equal(data.elements.find(e=>e.identifier==='enabled').states.checked,true);
  assert.equal(data.elements.find(e=>e.identifier==='advance').states.pressed,'mixed');
  const password=data.elements.find(e=>e.identifier==='password');
  assert.equal(password.value,'[redacted]');assert.equal(password.name,'[password control]');
  assert.match(data.elements.find(e=>e.tag==='canvas').limitation,/Pixels/);
  assert.match(data.elements.find(e=>e.tag==='iframe').limitation,/omitted/);
  assert.equal(data.omissions.childDocuments,1);
  assert.equal(data.coordinates.unit,'CSS pixels');
  assert.deepEqual(data.elements.find(e=>e.identifier==='advance').bounds,{x:0,y:10,width:100,height:20});
});

test('Chrome snapshot reports output truncation and rejects mismatched document or unavailable coordinate semantics',()=>{
  const data=normalize(chromeFixture(),{maxChars:5,maxElements:1});
  assert.equal(data.text.length,5);assert.equal(data.truncated.text,true);assert.equal(data.elements.length,1);assert.equal(data.truncated.elements,true);
  let f=chromeFixture();f.metrics={visualViewport:f.metrics.cssVisualViewport};assert.throws(()=>normalize(f),/CSS viewport/);
  f=chromeFixture();f.snapshot.documents[0].frameId=-1;assert.throws(()=>normalize(f),/bound/);
  f=chromeFixture();f.snapshot.documents[0].nodes.parentIndex[2]=2;assert.throws(()=>normalize(f),/hierarchy/);
  for(const query of [{expectedUrl:'file:///secret'},{javascript:'alert(1)'},{maxChars:30001},{maxElements:0},{targetId:'background'}])assert(!chromeReadSchema.safeParse(query).success);
});
test('physical layout units are converted before viewport filtering, including nonzero scroll offsets',()=>{
  const fixture=chromeFixture();
  fixture.snapshot.documents[0].layout.bounds=fixture.snapshot.documents[0].layout.bounds.map(b=>b.map(v=>v*3.5));
  fixture.metrics.visualViewport.clientWidth*=3.5;fixture.metrics.visualViewport.clientHeight*=3.5;
  fixture.metrics.cssVisualViewport.pageY=5;fixture.metrics.visualViewport.pageY=17.5;
  const result=normalize(fixture),control=result.elements.find(e=>e.identifier==='advance');
  assert.deepEqual(control.bounds,{x:0,y:10,width:100,height:20});
  assert.deepEqual(control.viewportBounds,{x:0,y:5,width:100,height:20});
  assert.equal(result.coordinates.conversion.cssPixelsPerLayoutUnit,1/3.5);
  assert(result.elements.some(e=>e.identifier==='password'));
  delete fixture.metrics.visualViewport;assert.throws(()=>normalize(fixture),/conversion/);
});

function harness({visible=['front'],mutation,asleep=false,foregroundChange=false,frozenBackground=false}={}) {
  const commands=[];let checks=0;
  const adb={
    shell:(_,...args)=>{commands.push(args);return args.join(' ')==='dumpsys power'?`mWakefulness=${asleep?'Dozing':'Awake'}`:'showing=false\nsecure=false';},
    getCurrentApp:()=>({packageName:foregroundChange&&checks++?'org.other':'com.android.chrome'}),
    adb:(_,...args)=>{commands.push(args);return Buffer.from(args[1]==='tcp:0'?'31337':'');},
  };
  const transport={list:async()=>[{id:'background',type:'page',url:'https://background.example/'},{id:'front',type:'page',url:'https://fixture.example/page'}],connect:async(_,id)=>({
    close:()=>commands.push(['close',id]),
    call:async(method,params)=>{
      commands.push(['cdp',id,method]);
      if(frozenBackground&&id==='background')throw new Error('Suspended renderer');
      if(method==='Runtime.evaluate')return {result:{value:{url:'https://fixture.example/page',visible:visible.includes(id),focused:visible.includes(id)}}};
      const result=fixtureRpc(method,params);mutation?.(method,result,commands);return result;
    },
  })};return {adb,transport,commands};
}
test('Chrome read inspects content only for the unique foreground page and removes only its own forward',async()=>{
  const h=harness();const result=await captureChromePage(h.adb,'test',{},h.transport);
  assert.equal(result.targetId,'front');assert.equal(result.wakeRequested,false);
  assert(h.commands.filter(c=>c[0]==='cdp'&&c[1]==='background').every(c=>c[2]==='Runtime.evaluate'));
  assert.deepEqual(h.commands.at(-1),['forward','--remove','tcp:31337']);
  assert(!JSON.stringify(h.commands).match(/input|screencap|uiautomator|activate|enable|Debugger/));
});
test('a suspended background renderer does not veto the responding foreground page; exact URL avoids probing it',async()=>{
  const h=harness({frozenBackground:true});const data=await captureChromePage(h.adb,'test',{},h.transport);
  assert.equal(data.targetId,'front');assert.equal(data.targetDiscovery.unavailable,1);
  const exact=harness({frozenBackground:true});
  await captureChromePage(exact.adb,'test',{expectedUrl:'https://fixture.example/page'},exact.transport);
  assert(!exact.commands.some(c=>c[0]==='cdp'&&c[1]==='background'));
});
test('Chrome target ambiguity, URL mismatch, navigation and foreground changes fail without a stale snapshot',async()=>{
  for(const scenario of ['ambiguous','mismatch','navigation','foreground','protocol']){
    const h=harness({visible:scenario==='ambiguous'?['front','background']:['front'],foregroundChange:scenario==='foreground',
      mutation:(method,result,commands)=>{
        if(scenario==='protocol'&&method==='DOMSnapshot.captureSnapshot')throw new Error('synthetic protocol failure');
        if(scenario==='navigation'&&method==='Page.getFrameTree'&&commands.filter(c=>c[2]===method).length>1)result.frameTree.frame.loaderId='new-document';
      }});
    await assert.rejects(captureChromePage(h.adb,'test',scenario==='mismatch'?{expectedUrl:'https://fixture.example/other'}:{},h.transport));
    assert.deepEqual(h.commands.at(-1),['forward','--remove','tcp:31337']);
    if(['ambiguous','mismatch'].includes(scenario))assert(!h.commands.some(c=>c[2]==='DOMSnapshot.captureSnapshot'));
  }
  const sleeping=harness({asleep:true});await assert.rejects(captureChromePage(sleeping.adb,'test',{},sleeping.transport),/already-awake/);
  assert(!sleeping.commands.some(c=>c[0]==='forward'));
});
test('real stalled Chrome handshake respects inherited deadline and releases the socket',async t=>{
  const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
  const start=performance.now();
  await assert.rejects(withDeadline(150,()=>ChromeConnection.connect(server.address().port,'stalled')),/timed out/);
  assert(performance.now()-start<1000);
});
