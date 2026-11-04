import { fixtureOwner } from './fixtures/owner.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const texts=result=>result.content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return c.text;}});
test('dropped image response recovers by caller ID without replay; deferred action and missing image retain receipts',async t=>{
  fs.mkdirSync('.runtime',{recursive:true});
  const directory=fs.mkdtempSync(path.resolve('.runtime/recovery-test-'));
  const owner=fixtureOwner(directory);
  const trace=path.join(directory,'commands.jsonl');
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,['--import','./scripts/fixtures/fake-adb.mjs','dist/phone.js'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
    PHONE_SECURITY_FILE:owner.file,PHONE_TEST_AWAKE:'1',PHONE_DEVICE:'synthetic-device',PHONE_PORT:String(port),PHONE_DATA_DIR:directory,PHONE_TEST_TRACE:trace,PHONE_SUMMARY_API_KEY:'',PHONE_SUMMARY_KEY_FILE:''}});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  t.after(()=>child.kill());
  for(let n=0;;n++){try{assert((await fetch(`http://127.0.0.1:${port}/healthz`,{headers:owner.headers})).ok);break;}catch{if(n>400||child.exitCode!==null)throw Error('Fixture startup failed or exceeded 20 seconds: '+errors);await new Promise(r=>setTimeout(r,50));}}
  let dropped=0;
  const proxy=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await fetch(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:{...req.headers,host:`127.0.0.1:${port}`},body:Buffer.concat(chunks)});
      const bytes=Buffer.from(await response.arrayBuffer());
      if(dropped===0 && bytes.toString().includes('"type":"image"')){dropped++;res.destroy();return;}
      res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json'});res.end(bytes);
    }catch{res.destroy();}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>{proxy.closeAllConnections();proxy.close();});
  const client=new Client({name:'recovery-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${proxy.address().port}/mcp`),{requestInit:{headers:owner.headers}}));
  t.after(()=>client.close());
  owner.wrap(client);
  const requestId='test-dropped-response';
  await assert.rejects(()=>client.callTool({name:'android_tap',arguments:{x:10,y:20,requestId}}));
  assert.equal(dropped,1);
  const read=await client.callTool({name:'android_activity_open',arguments:{requestId,receiptOnly:true}});
  assert(!read.isError);assert(!read.content.some(c=>c.type==='image'));
  const receipt=texts(read)[0].phoneReceipt;
  assert(!JSON.stringify(read).includes('"recent"'));assert(!JSON.stringify(read).includes('"checkpoint"'));
  assert.equal(receipt.execution,'acknowledged');assert.equal(receipt.callOutcome,'completed');assert(receipt.screenshotAvailable);
  const rows=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(r=>JSON.parse(r));
  const taps=()=>rows().filter(r=>r.args[0]==='input'&&r.args[1]==='tap').length;
  assert.equal(taps(),1);
  const replay=await client.callTool({name:'android_tap',arguments:{x:10,y:20,requestId}});
  assert(replay.isError);assert.equal(texts(replay)[1].phoneReceipt.eventId,receipt.eventId);assert.equal(taps(),1);
  const changedReplay=await client.callTool({name:'android_tap',arguments:{x:33,y:20,requestId}});
  assert(changedReplay.isError);assert.equal(taps(),1);
  const beforeImage=rows().length;
  const image=await client.callTool({name:'android_activity_open',arguments:{requestId,receiptOnly:true,includeScreenshot:true,imageMaxEdge:256}});
  assert(!image.isError);assert(image.content.some(c=>c.type==='image'));assert.equal(taps(),1);
  assert.equal(rows().length,beforeImage,'recovery reads only host storage, without ADB');
  const deferred=await client.callTool({name:'android_tap',arguments:{x:12,y:20,requestId:'test-deferred-action',imageMode:'deferred'}});
  assert(!deferred.isError);assert(!deferred.content.some(c=>c.type==='image'));
  assert.equal(texts(deferred).find(c=>c.phoneReceipt).phoneReceipt.execution,'acknowledged');
  assert.equal(texts(deferred).find(c=>c.phoneObservation).phoneObservation.screenshot.returnedInline,false);
  const failed=await client.callTool({name:'android_tap',arguments:{x:99,y:20,requestId:'test-unconfirmed-input',imageMode:'deferred'}});
  assert(failed.isError);assert.equal(texts(failed).find(c=>c.phoneReceipt).phoneReceipt.execution,'unconfirmed');
  const privateAction=await client.callTool({name:'android_tap',arguments:{x:13,y:20,requestId:'test-private-action',context:{private:true,intent:'secret-intent'}}});
  assert(!privateAction.isError);
  const missing=await client.callTool({name:'android_activity_open',arguments:{requestId:'test-private-action',receiptOnly:true,includeScreenshot:true}});
  assert(!missing.isError);assert.equal(texts(missing)[0].phoneReceipt.execution,'acknowledged');
  assert.equal(texts(missing).find(c=>c.phoneImage).phoneImage.status,'unavailable');
  assert(!JSON.stringify(missing).includes('secret-intent'));
  const badCapture=await client.callTool({name:'android_tap',arguments:{x:88,y:20,requestId:'test-bad-capture'}});
  assert(!badCapture.isError);assert(!badCapture.content.some(c=>c.type==='image'));
  assert.equal(texts(badCapture).find(c=>c.phoneReceipt).phoneReceipt.execution,'acknowledged');
  assert.equal(texts(badCapture).find(c=>c.phoneReceipt).phoneReceipt.screenshotAvailable,false);
  assert(texts(badCapture).find(c=>c.phoneObservation).phoneObservation.errors.length>0);
  const beforeConcurrent=taps();
  const duplicates=await Promise.all([1,2].map(()=>client.callTool({name:'android_tap',arguments:{x:14,y:20,requestId:'concurrent-same-request',imageMode:'deferred'}})));
  assert.equal(duplicates.filter(r=>r.isError).length,1);assert.equal(taps(),beforeConcurrent+1);
  const beforeUnknown=rows().length;
  const unknown=await client.callTool({name:'android_activity_open',arguments:{requestId:'unknown-request-001',receiptOnly:true}});
  assert(unknown.isError);assert.match(unknown.content[0].text,/execution is unknown/);assert.equal(rows().length,beforeUnknown);
});
