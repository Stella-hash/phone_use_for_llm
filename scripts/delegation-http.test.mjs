import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {fixtureOwner} from './fixtures/owner.mjs';
import {writePrivate} from '../dist/private-files.js';
import {navigation} from '../dist/delegation-navigation.js';

test('installed public HTTP catalog authenticates and runs optional Chrome reading with only synthetic dependencies',async t=>{
  fs.mkdirSync('.runtime',{recursive:true});const dir=fs.mkdtempSync(path.resolve('.runtime/delegate-http-'));
  const owner=fixtureOwner(dir);const keyFile=path.join(dir,'owner-config','model.key');writePrivate(keyFile,'synthetic-provider-key-only');
  fs.writeFileSync(owner.file,JSON.stringify({...owner.config,delegation:{enabled:true,acceptsModelEgress:true,keyFile,model:'synthetic-clean-model'}}));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const trace=path.join(dir,'trace.jsonl');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP'].includes(k)));
  const child=spawn(process.execPath,['--import','./scripts/fixtures/fake-adb.mjs','--import','./scripts/fixtures/delegation-model.mjs','dist/phone.js'],{
    windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,PHONE_SECURITY_FILE:owner.file,PHONE_DEVICE:'synthetic-device',PHONE_PORT:String(port),PHONE_TEST_TRACE:trace,PHONE_TEST_AWAKE:'1',PHONE_TEST_WEBVIEW:'1'}});
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  const client=new Client({name:'synthetic-delegation',version:'1'});
  t.after(async()=>{await client.close();if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r))}});
  const endpoint=`http://127.0.0.1:${port}`;
  for(let i=0;;i++){try{assert((await fetch(endpoint+'/healthz',{headers:owner.headers})).ok);break}catch{if(i>400||child.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,50))}}
  assert.equal((await fetch(endpoint+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'android_delegate_start',arguments:{requestId:'unauthenticated-read',url:'https://fixture.example/page',goal:'read'}}})})).status,401);
  assert(!fs.existsSync(trace));
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint+'/mcp'),{requestInit:{headers:owner.headers}}));
  const catalog=(await client.listTools()).tools;assert.equal(catalog.length,36);
  assert.equal(catalog.find(t=>t.name==='android_delegate_start').annotations.readOnlyHint,false);
  assert.equal(catalog.find(t=>t.name==='android_delegate_status').annotations.readOnlyHint,true);
  for(const name of ['android_delegate_start','android_delegate_update','android_delegate_stop'])
    assert.equal(catalog.find(t=>t.name===name).annotations.destructiveHint,true);
  assert.equal(catalog.find(t=>t.name==='android_delegate_status').annotations.destructiveHint,false);
  const initialBudget={modelCalls:3,seconds:120,totalTokens:16000};
  const started=await client.callTool({name:'android_delegate_start',arguments:{requestId:'http-delegation-001',url:'https://fixture.example/page',goal:'Read one visible paragraph',budget:initialBudget}});
  assert(!started.isError,JSON.stringify(started));const initial=JSON.parse(started.content[0].text).phoneDelegation;
  const final=await client.callTool({name:'android_delegate_status',arguments:{startRequestId:'http-delegation-001',waitMs:10000}});
  assert(!final.isError,JSON.stringify(final));const result=JSON.parse(final.content[0].text).phoneDelegation;
  assert.equal(result.runId,initial.runId);assert.equal(result.status,'yielded',JSON.stringify(result));assert(result.handoffReady);
  assert.equal(result.usage.totalTokens,42);assert.equal(result.finding.evidence[0].sourceType,'chrome_text');
  assert.equal(result.finding.evidence[0].url,'https://fixture.example/page');
  const update=await client.callTool({name:'android_delegate_update',arguments:{runId:initial.runId,requestId:'http-update-001',expectedVersion:1,goal:'Reconsider the visible paragraph'}});
  assert(!update.isError,JSON.stringify(update));
  const updated=JSON.parse((await client.callTool({name:'android_delegate_status',arguments:{runId:initial.runId,waitMs:10000}})).content[0].text).phoneDelegation;
  assert.equal(updated.status,'yielded');assert.equal(updated.usage.totalTokens,84);assert.deepEqual(updated.budget,initialBudget);
  const commands=fs.readFileSync(trace,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
  assert(!commands.some(c=>c.args[0]==='input'||c.args.includes('KEYCODE_WAKEUP')));
  // Exercise the real list-elements mapping, selector conversion and signed public input path.
  const listed=await client.callTool({name:'android_list_elements',arguments:{expectedPackage:'com.android.chrome',expectedUrl:'https://fixture.example/page'}});
  assert(!listed.isError,JSON.stringify(listed));
  const elements=listed.content.filter(c=>c.type==='text').flatMap(c=>{try{return JSON.parse(c.text).elements??[]}catch{return []}});
  const index=elements.findIndex(e=>e.identifier==='fixture:id/article');assert(index>=0);assert.equal(elements[index].webView,1);
  const op=navigation({action:'tap',targetIndex:index,value:null},{elements},elements,true);
  const tapped=await client.callTool(owner.authorize({name:op.name,arguments:{...op.args,expectedPackage:'com.android.chrome',expectedUrl:'https://fixture.example/page'}}));
  assert(!tapped.isError,JSON.stringify(tapped));
  assert.equal(fs.readFileSync(trace,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)).filter(c=>c.args[0]==='input'&&c.args[1]==='tap').length,1);
});
