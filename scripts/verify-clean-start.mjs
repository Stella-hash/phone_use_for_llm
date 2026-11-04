// Fresh-install verification with generated owner keys and a synthetic USB transport.
// Never contacts ADB, a phone, a model endpoint or private configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canonical } from '../dist/security.js';
import { readPrivate, writePrivate } from '../dist/private-files.js';
const root=path.resolve(import.meta.dirname,'..'),envFile=path.join(root,'.env');
assert(!fs.existsSync(envFile),'Use a fresh directory with no .env');
fs.mkdirSync(path.join(root,'.runtime'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.runtime/clean-start-'));
const trace=path.join(directory,'trace.jsonl');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP'].includes(key)));
const run=(args,options={})=>{
  const r=spawnSync(process.execPath,args,{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:20000,...options});
  assert.equal(r.status,0,r.stderr);return r.stdout;
};
const missing=spawnSync(process.execPath,['--import','./scripts/fixtures/fake-adb.mjs','dist/phone.js'],{cwd:root,env:{...env,PHONE_TEST_TRACE:trace},windowsHide:true,encoding:'utf8',timeout:10000});
assert.notEqual(missing.status,0);assert.match(missing.stderr,/PHONE_SECURITY_FILE is required/);assert(!fs.existsSync(trace));
run(['scripts/owner-setup.mjs',path.join(directory,'service'),path.join(directory,'signer'),'fixture-owner']);
const securityFile=path.join(directory,'service/security.json');
const config=JSON.parse(readPrivate(securityFile,32768));
config.allowedApps=['org.example.game'];
fs.writeFileSync(securityFile,JSON.stringify(config));
const token=readPrivate(path.join(directory,'service/token.key'),256).trim();
const headers={Authorization:`Bearer ${token}`};
const request={name:'android_tap',arguments:{x:10,y:20,requestId:'fresh-install-action-001',expectedPackage:'org.example.game',imageMode:'deferred'}};
const requestFile=path.join(directory,'service/request.json'),approvedFile=path.join(directory,'service/approved.json');
writePrivate(requestFile,JSON.stringify(request));
const digest=createHash('sha256').update(canonical(request)).digest('hex');
run(['scripts/owner-approve.mjs',securityFile,path.join(directory,'signer/approval.key'),requestFile,approvedFile],{input:`APPROVE ${digest.slice(0,12)}\n`});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
const port=socket.address().port;await new Promise(r=>socket.close(r));
writePrivate(envFile,`PHONE_DEVICE=synthetic-device\nPHONE_PORT=${port}\nPHONE_SECURITY_FILE=${JSON.stringify(securityFile.split(path.sep).join('/'))}\n`);
env.PHONE_TEST_TRACE=trace;env.PHONE_TEST_AWAKE='1';env.PHONE_TEST_PACKAGE='org.example.game';
const start=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts.start.split(' ');assert.equal(start.shift(),'node');
let child,stderr='';const client=new Client({name:'clean-install',version:'1'});
try{
  child=spawn(process.execPath,['--import','./scripts/fixtures/fake-adb.mjs',...start],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',c=>stderr+=c);
  for(let n=0;;n++){try{assert((await fetch(`http://127.0.0.1:${port}/healthz`,{headers})).ok);break;}catch{if(n>160||child.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,50));}}
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,401);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers}}));
  assert.equal((await client.listTools()).tools.length,26);
  const result=await client.callTool(JSON.parse(readPrivate(approvedFile,65536)));assert(!result.isError,JSON.stringify(result));
  assert(!result.content.some(c=>c.type==='image'));
  const receipt=await client.callTool({name:'android_activity_open',arguments:{requestId:request.arguments.requestId,receiptOnly:true}});
  assert.equal(JSON.parse(receipt.content[0].text).phoneReceipt.execution,'acknowledged');
  const utilityEnv={...env,PHONE_SECURITY_FILE:securityFile,PHONE_PORT:String(port)};
  run(['scripts/check-mcp.mjs'],{env:utilityEnv});
  run(['scripts/export-activity.mjs',path.join(directory,'export')],{env:utilityEnv});
  const health=await(await fetch(`http://127.0.0.1:${port}/healthz`,{headers})).json();
  assert.equal(health.summary.state,'not_configured');
  console.log(JSON.stringify({defaultStartVerified:true,missingConfigRejected:true,ownerSetupAndApprovalVerified:true,authenticatedTools:26,
    syntheticDevice:true,modelSummaries:health.summary.state,privateConfigurationLoaded:false,receiptRecovered:true,privateExportVerified:true}));
}finally{
  await client.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}fs.unlinkSync(envFile);
}
