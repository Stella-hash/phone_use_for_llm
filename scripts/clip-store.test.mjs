import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ClipStore, CLIP_MAX_BYTES, CLIP_MAX_FRAMES, CLIP_ALLOCATION_BYTES, parseClipProbe } from '../dist/clip-store.js';
import { withDeadline } from '../dist/deadline.js';
import { writePrivate } from '../dist/private-files.js';
import { PNG } from 'pngjs';

const ffmpeg=process.env.PHONE_FFMPEG||'ffmpeg', ffprobe=process.env.PHONE_FFPROBE||'ffprobe';
const available=command=>{try{execFileSync(command,['-version'],{stdio:'ignore',windowsHide:true,timeout:3000});return true;}catch{return false;}};
const mediaAvailable=available(ffmpeg)&&available(ffprobe);
const directory=()=>fs.mkdtempSync(path.join(os.tmpdir(),'phone-clips-'));
const probe=times=>({streams:[{codec_type:'video',codec_name:'h264',width:320,height:180}],
  frames:times.map(pts_time=>({pts_time,width:320,height:180})),format:{duration:'1.000000'}});
const digest=value=>createHash('sha256').update(value).digest('hex');
// Storage contract fixture: no claim that this synthetic container can decode.
// Actual FFmpeg decoding is covered separately when the dependency is installed.
function fixture(options={},eventId=101,root=directory()) {
  const initial=new ClipStore(root,options), allocation=initial.allocate(eventId);
  const allocated=JSON.parse(fs.readFileSync(path.join(allocation.directory,'allocation.json'),'utf8'));
  const video=Buffer.from([0x1a,0x45,0xdf,0xa3,eventId%256]);fs.writeFileSync(allocation.videoPath,video);
  const parsed=parseClipProbe(probe(['0.000','0.200']));
  const record={version:1,id:allocation.id,eventId,allocatedAt:allocated.allocatedAt,completedAt:new Date().toISOString(),
    expiresAt:new Date(Date.parse(allocated.allocatedAt)+initial.options.cacheMaxAgeMs).toISOString(),status:'complete',storage:'owner-host',
    origin:{tool:'android_capture_clip'},video:{filename:'source.mkv',sha256:digest(video),bytes:video.length,...parsed.video},...parsed};
  record.video={filename:'source.mkv',sha256:digest(video),bytes:video.length,...parsed.video};
  writePrivate(path.join(allocation.directory,'record.json'),JSON.stringify(record));
  return {root,store:new ClipStore(root,options),allocation,record,video};
}

test('clip timestamps preserve variable intervals and explicit decoder provenance without inventing missing frames',()=>{
  const parsed=parseClipProbe(probe(['10.000000','10.040000','10.160000']));
  assert.deepEqual(parsed.frames.map(frame=>frame.ptsMs),[10000,10040,10160]);
  assert.deepEqual(parsed.frames.map(frame=>frame.relativeMs),[0,40,160]);
  assert.equal(parsed.video.frameCount,3);assert.equal(parsed.video.spanMs,160);
  assert.equal(parsed.timing.variableIntervals,true);assert.equal(parsed.timing.minIntervalMs,40);assert.equal(parsed.timing.maxIntervalMs,120);
  assert.equal(parsed.timing.observedFrameRate,12.5);assert.equal(parsed.timing.droppedFrames,null);
  const fallback=probe(['0.000000']);delete fallback.frames[0].pts_time;fallback.frames[0].best_effort_timestamp_time='0.050000';
  const single=parseClipProbe(fallback);assert.equal(single.frames[0].timestampKind,'decoder-best-effort');
  assert.equal(single.video.spanMs,0);assert.equal(single.timing.observedFrameRate,null);
  assert.equal(single.timing.minIntervalMs,null);assert.equal(single.timing.droppedFrames,null);
});

test('clip metadata refuses missing timestamps, nonmonotonic time, oversized geometry and excessive recording bounds',()=>{
  const missing=probe(['0.0']);delete missing.frames[0].pts_time;
  assert.throws(()=>parseClipProbe(missing),/TIMESTAMP_UNAVAILABLE/);
  assert.throws(()=>parseClipProbe(probe(['0.1','0.0'])),/NONMONOTONIC/);
  assert.throws(()=>parseClipProbe(probe(['0.0','10.001'])),/DURATION_LIMIT/);
  const long=probe(['0.0']);long.format.duration='15.001';assert.throws(()=>parseClipProbe(long),/DURATION_LIMIT/);
  const huge=probe(['0.0']);huge.frames[0].width=1921;assert.throws(()=>parseClipProbe(huge),/DIMENSION_LIMIT/);
  assert.throws(()=>parseClipProbe(probe(Array.from({length:CLIP_MAX_FRAMES+1},()=> '0.0'))),/INVALID_VIDEO/);
  const unknown=probe(['0.0']);unknown.streams[0].codec_type='audio';assert.throws(()=>parseClipProbe(unknown),/INVALID_VIDEO/);
  const changed=probe(['0.0','0.1']);changed.frames[1].width=180;changed.frames[1].height=320;
  assert.equal(parseClipProbe(changed).timing.dimensionsChanged,true);
});

test('failed and pending clip allocations survive restart with honest cache expiry and no false image',()=>{
  const root=directory(),store=new ClipStore(root),pending=store.allocate(11),failed=store.allocate(12);
  const partial=Buffer.from([0x1a,0x45,0xdf,0xa3,0x00]);fs.writeFileSync(failed.videoPath,partial);
  assert.throws(()=>store.open(pending.id),/NOT_COMPLETE/);
  const failure=store.fail(failed.id,{error:'Synthetic interrupted recorder'});
  assert.equal(failure.status,'failed');assert.equal(failure.imageAvailable,false);assert.equal(failure.partialMediaRetained,true);
  assert.equal(failure.sha256,createHash('sha256').update(partial).digest('hex'));
  assert.deepEqual(store.fail(failed.id,{error:'Later explanation'}),failure);
  assert.throws(()=>store.finalize(failed.id,{}),/ALREADY_FAILED/);
  const restarted=new ClipStore(root),page=restarted.list({limit:1});
  assert.equal(page.records.length,1);assert(page.nextBefore);
  const second=restarted.list({limit:1,before:page.nextBefore});assert.equal(second.records.length,1);assert.equal(second.nextBefore,null);
  assert.deepEqual(new Set([...page.records,...second.records].map(record=>record.status)),new Set(['pending','failed']));
  assert.deepEqual(fs.readFileSync(failed.videoPath),partial);assert(fs.existsSync(pending.videoPath));
  assert.equal(restarted.status().cache.count,2);assert(page.records.every(record=>Number.isFinite(Date.parse(record.expiresAt))));
  for(const id of ['../source.mkv','clip-0-'+randomUUID(),'clip-1-not-a-uuid']) assert.throws(()=>store.open(id),/INVALID_ID/);
  assert.throws(()=>store.list({before:'clip-1-'+randomUUID()}),/INVALID_CURSOR/);
});

test('clip hard links, directory links and oversized files are rejected while the source evidence remains',()=>{
  const root=directory(),store=new ClipStore(root),allocation=store.allocate(21);
  fs.truncateSync(allocation.videoPath,CLIP_MAX_BYTES+1);
  assert.throws(()=>store.finalize(allocation.id,{}),/INVALID_STORAGE/);
  assert.equal(fs.statSync(allocation.videoPath).size,CLIP_MAX_BYTES+1);
  // Remove only this fixture's oversized placeholder before replacing it with a hard-link fixture.
  fs.unlinkSync(allocation.videoPath);
  const outside=path.join(root,'outside.mkv');writePrivate(outside,Buffer.from([0x1a,0x45,0xdf,0xa3]));
  fs.linkSync(outside,allocation.videoPath);
  assert.throws(()=>store.finalize(allocation.id,{}),/INVALID_STORAGE/);
  assert.equal(fs.statSync(outside).nlink,2);
  const linked='clip-22-'+randomUUID(),outsideDirectory=path.join(root,'outside-directory');fs.mkdirSync(outsideDirectory);
  fs.symlinkSync(outsideDirectory,path.join(store.directory,linked),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>store.open(linked),/links|INVALID_STORAGE/i);
  assert(fs.existsSync(outsideDirectory));
});

test('real Matroska timestamps, exact frame ordinals and independent keepsakes survive cache expiry',
  {skip:!mediaAvailable?'ffmpeg and ffprobe are not available on this host':false},()=>{
  const root=directory(),store=new ClipStore(root,{keepsakesEnabled:true}),allocation=store.allocate(31);
  execFileSync(ffmpeg,['-v','error','-nostdin','-f','lavfi','-i','testsrc2=size=160x90:rate=5','-frames:v','5',
    '-vf','setpts=N*N/(5*TB)','-vsync','0','-c:v','ffv1','-f','matroska','-y',allocation.videoPath],
    {windowsHide:true,stdio:'pipe',timeout:10000});
  const record=store.finalize(allocation.id,{expectedPackage:'synthetic.fixture',requestedDurationMs:3000});
  assert.equal(record.status,'complete');assert.equal(record.video.frameCount,5);assert.equal(record.timing.droppedFrames,null);
  assert.deepEqual(record.frames.map(frame=>frame.relativeMs),[0,200,800,1800,3200]);
  assert.equal(record.timing.variableIntervals,true);assert.equal(record.timing.maxIntervalMs,1400);
  fs.utimesSync(allocation.videoPath,new Date('2000-01-01'),new Date('2000-01-01'));
  assert.deepEqual(new ClipStore(root).open(record.id),record,'file mtime does not substitute for allocation expiry');
  assert.deepEqual(store.finalize(record.id,{ignored:'Never overwrite provenance'}),record);
  const first=store.frame(record.id,0),last=store.frame(record.id,4),middle=store.frame(record.id,2);
  assert.equal(middle.ptsMs,800);assert.equal(middle.index,2);assert.equal(middle.width,160);assert.equal(middle.height,90);
  assert(!first.png.equals(last.png),'exact decoder ordinal must select distinct source frames');
  assert.throws(()=>store.frame(record.id,5),/OUT_OF_RANGE/);
  assert.throws(()=>withDeadline(0,()=>store.frame(record.id,0)),/deadline/);
  assert(!fs.readdirSync(allocation.directory).some(name=>name.endsWith('.png')),'frame extraction should not expand the archive into PNG copies');
  const whole=store.keep(record.id,'Complete clip','Synthetic keepsake'),selected=store.keep(record.id,'One moment',undefined,2);
  assert.equal(whole.created,true);assert.equal(whole.record.frameIndex,null);assert.equal(selected.record.ptsMs,800);
  assert.equal(store.keep(record.id,'Do not overwrite').record.title,'Complete clip');
  assert.equal(store.keep(record.id,'Do not overwrite').created,false);
  const page=store.keepsakes({limit:1});assert(page.nextBefore);assert.equal(page.status.maxBytes,256*1024*1024);assert.equal(page.status.maxCount,1000);
  assert.equal(store.keepsakes({before:page.nextBefore,limit:1}).records.length,1);
  assert.throws(()=>store.keep(record.id,'bad',undefined,-1),/OUT_OF_RANGE/);
  const changed=fs.readFileSync(allocation.videoPath);changed[changed.length-1]^=1;fs.writeFileSync(allocation.videoPath,changed);
  assert.throws(()=>store.open(record.id),/CHECKSUM_MISMATCH/);
  assert.throws(()=>store.frame(record.id,0),/CHECKSUM_MISMATCH/);
  assert(fs.existsSync(allocation.videoPath),'corruption must not delete source evidence');
  fs.writeFileSync(allocation.videoPath,Buffer.from(changed.map((value,index)=>index===changed.length-1?value^1:value)));
  store.prune(Date.parse(record.expiresAt)+1);assert(!fs.existsSync(allocation.directory));
  const restarted=new ClipStore(root,{keepsakesEnabled:true});
  assert.equal(restarted.openKeepsake(whole.record.id).clip.video.sha256,record.video.sha256);
  assert.deepEqual(restarted.keptFrame(whole.record.id,2).png,middle.png);
  assert.deepEqual(restarted.keptFrame(selected.record.id).png,middle.png);
  assert.equal(restarted.keep(record.id,'Retry after expiry').created,false,'existing copied keepsake supports recovery after source expiry');
});

test('public clip cache reserves bounded capacity, preserves active capture and evicts only old eligible entries',()=>{
  assert.throws(()=>new ClipStore(directory(),{cacheMaxBytes:null}),/INVALID_LIMIT/);
  assert.throws(()=>new ClipStore(directory(),{cacheMaxAgeMs:31*86400000}),/INVALID_LIMIT/);
  const tiny=new ClipStore(directory(),{cacheMaxBytes:CLIP_ALLOCATION_BYTES-1});
  assert.throws(()=>tiny.allocate(1),/CACHE_CAPACITY_REACHED/);assert.equal(tiny.status().cache.count,0);
  const root=directory(),store=new ClipStore(root,{cacheMaxBytes:CLIP_ALLOCATION_BYTES,cacheMaxCount:1}),active=store.allocate(1);
  assert.equal(store.status().cache.usedBytes+store.status().cache.reservedBytes,CLIP_ALLOCATION_BYTES);
  const another=new ClipStore(root,{cacheMaxBytes:CLIP_ALLOCATION_BYTES,cacheMaxCount:1});
  assert.equal(another.status().cache.usedBytes+another.status().cache.reservedBytes,CLIP_ALLOCATION_BYTES,'reservation survives a process restart');
  assert.throws(()=>another.allocate(2),/CACHE_CAPACITY_REACHED/);
  store.prune(Date.now()+40*86400000);assert(fs.existsSync(active.directory),'maintenance must not delete the active recorder');
  assert.throws(()=>store.allocate(2),/CACHE_CAPACITY_REACHED/);
  store.fail(active.id,{error:'synthetic failure'});
  const replacement=store.allocate(2);assert(!fs.existsSync(active.directory));assert(fs.existsSync(replacement.directory));
  assert.equal(store.status().cache.count,1);
  const lock=path.join(store.directory,'.write.lock');writePrivate(lock,'synthetic live writer');
  assert.throws(()=>store.prune(),/CACHE_STORAGE_BUSY/);assert.throws(()=>store.allocate(3),/CACHE_STORAGE_BUSY/);
  assert.equal(fs.readFileSync(lock,'utf8'),'synthetic live writer','failed lock acquisition never clears another writer lock');fs.unlinkSync(lock);
});

test('cache pruning preserves foreign directories, extra files, malformed receipts, symlinks and hardlinks',()=>{
  const root=directory(),initial=new ClipStore(root),good=initial.allocate(1),extra=initial.allocate(2),bad=initial.allocate(3);
  initial.fail(good.id,{error:'expired fixture'});initial.fail(extra.id,{error:'extra file fixture'});initial.fail(bad.id,{error:'malformed fixture'});
  fs.writeFileSync(path.join(extra.directory,'owner-photo.png'),'do not delete');
  fs.writeFileSync(path.join(bad.directory,'failure.json'),'{not valid json');
  const foreign=path.join(initial.directory,'family-photos');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'photo.jpg'),'preserve');
  const linked='clip-22-'+randomUUID(),outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'note.txt'),'preserve');
  fs.symlinkSync(outside,path.join(initial.directory,linked),process.platform==='win32'?'junction':'dir');
  const hard=path.join(root,'outside-file');fs.writeFileSync(hard,'preserve');
  fs.unlinkSync(path.join(extra.directory,'source.mkv'));fs.linkSync(hard,path.join(extra.directory,'source.mkv'));
  const store=new ClipStore(root),status=store.prune(Date.now()+40*86400000);
  assert(!fs.existsSync(good.directory));assert(fs.existsSync(extra.directory));assert(fs.existsSync(bad.directory));
  assert.equal(fs.readFileSync(path.join(foreign,'photo.jpg'),'utf8'),'preserve');
  assert.equal(fs.readFileSync(path.join(outside,'note.txt'),'utf8'),'preserve');assert.equal(fs.readFileSync(hard,'utf8'),'preserve');
  assert.equal(status.blockedEntries,4);assert(status.warning.includes('preserved'));
  assert.throws(()=>store.allocate(4),/REQUIRES_OWNER_INSPECTION/);
});

test('whole clips and selected frames are opt-in copies that survive eviction and enforce immutable budgets',()=>{
  const options={keepsakesEnabled:true,keepsakeMaxCount:2},data=fixture(options),{root,store,record,allocation,video}=data;
  assert.throws(()=>new ClipStore(root).keep(record.id,'Disabled'),/KEEPSAKES_DISABLED/);
  const png=PNG.sync.write(new PNG({width:320,height:180}));
  store.frame=(_id,index)=>({record,...record.frames[index],png});
  const whole=store.keep(record.id,'Whole clip'),selected=store.keep(record.id,'A frame',undefined,1);
  assert.equal(whole.record.frameIndex,null);assert.equal(selected.record.frameIndex,1);
  assert.equal(whole.record.expiresAt,null);assert.equal(whole.record.copiedMedia,true);
  assert.equal(selected.status.migrationRecommended,true);assert(selected.status.warning.includes('80%'));
  assert.equal(store.keep(record.id,'Ignored replacement').created,false);
  assert.equal(store.keep(record.id,'Ignored replacement').record.title,'Whole clip');
  assert.throws(()=>store.keep(record.id,'Third keepsake',undefined,0),/CAPACITY_REACHED/);
  assert.throws(()=>store.keptFrame(selected.record.id,0),/FRAME_NOT_KEPT/);
  store.prune(Date.parse(record.expiresAt)+1);assert(!fs.existsSync(allocation.directory));
  const restarted=new ClipStore(root,options),opened=restarted.openKeepsake(whole.record.id),frame=restarted.keptFrame(selected.record.id);
  assert.equal(opened.clip.video.sha256,digest(video));assert.deepEqual(frame.png,png);assert.equal(frame.index,1);
  assert.equal(restarted.keepsakes().records.length,2);assert.equal(restarted.status().keepsakes.count,2);
  assert.throws(()=>withDeadline(0,()=>restarted.keepsakes()),/deadline/);
  assert.throws(()=>withDeadline(0,()=>restarted.status()),/deadline/);
  assert.equal(restarted.keep(record.id,'Retry after source expiry').created,false);
  const keptDirectory=path.join(store.keepsakesDirectory,whole.record.id),keptMedia=path.join(keptDirectory,'source.mkv');
  assert.equal(fs.statSync(keptMedia).nlink,1);assert.deepEqual(fs.readFileSync(keptMedia),video);
  const exportPath=path.join(root,'verified-export'),disabled=new ClipStore(root);
  const exported=disabled.exportTo(exportPath);assert.equal(exported.count,2);assert.equal(exported.verified,true);assert.equal(exported.sourceRetained,true);
  const manifest=JSON.parse(fs.readFileSync(path.join(exportPath,'manifest.json'),'utf8'));
  assert.equal(manifest.records.length,2);assert.equal(manifest.checksum,'sha256');assert.equal(manifest.sourceRetained,true);
  for(const kept of [whole,selected]) {
    const source=path.join(store.keepsakesDirectory,kept.record.id),copy=path.join(exportPath,kept.record.id);
    for(const file of ['allocation.json','record.json','source.json',kept.record.media.filename])
      assert.deepEqual(fs.readFileSync(path.join(copy,file)),fs.readFileSync(path.join(source,file)));
  }
  assert.throws(()=>disabled.exportTo(exportPath),/DESTINATION_EXISTS/);
  assert.throws(()=>disabled.exportTo(path.join(store.keepsakesDirectory,'nested-export')),/INSIDE_SOURCE/);
  assert.throws(()=>disabled.exportTo(path.join(store.directory,'nested-export')),/INSIDE_SOURCE/);
  const changed=Buffer.from(video);changed[4]^=1;fs.writeFileSync(keptMedia,changed);
  assert.throws(()=>restarted.openKeepsake(whole.record.id),/CHECKSUM_MISMATCH/);
  assert(fs.existsSync(keptMedia),'keepsake corruption never triggers deletion');
  const failedExport=path.join(root,'failed-export');assert.throws(()=>disabled.exportTo(failedExport),/CHECKSUM_MISMATCH/);
  assert(!fs.existsSync(path.join(failedExport,'manifest.json')),'a failed export cannot have a successful manifest');
  assert(fs.existsSync(keptMedia),'export failures never delete source media');
});

test('keepsake byte budget refuses a copy before writing and reports migration at eighty percent',()=>{
  const first=fixture({keepsakesEnabled:true});
  const kept=first.store.keep(first.record.id,'Budget fixture');
  const used=kept.status.usedBytes;
  const near=new ClipStore(first.root,{keepsakesEnabled:true,keepsakeMaxBytes:Math.floor(used/0.8)});
  assert(near.status().keepsakes.migrationRecommended);
  const second=fixture({keepsakesEnabled:true,keepsakeMaxBytes:1});
  assert.throws(()=>second.store.keep(second.record.id,'Too large'),/CAPACITY_REACHED/);
  assert.equal(second.store.status().keepsakes.usedBytes,0);assert.equal(second.store.status().keepsakes.count,0);
  assert.deepEqual(fs.readdirSync(second.store.keepsakesDirectory),[]);
  const emptyDestination=path.join(second.root,'empty-export');assert.throws(()=>second.store.exportTo(emptyDestination),/EXPORT_EMPTY/);
  assert(!fs.existsSync(emptyDestination));
});

test('allocation and failed-save receipts remain recoverable when publication reports disk full',()=>{
  const root=directory(),store=new ClipStore(root),allocation=store.allocate(201),rename=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===path.join(allocation.directory,'failure.json')){const error=new Error('synthetic disk full');error.code='ENOSPC';throw error;}return rename(source,target);};
  try { assert.throws(()=>store.fail(allocation.id,{error:'recorder interrupted'}),/synthetic disk full/); }
  finally { fs.renameSync=rename; }
  assert(fs.existsSync(path.join(allocation.directory,'allocation.json')));assert(fs.existsSync(allocation.videoPath));
  const temporary=fs.readdirSync(allocation.directory).find(name=>name.startsWith('.metadata-'));
  assert(temporary);assert.equal(JSON.parse(fs.readFileSync(path.join(allocation.directory,temporary),'utf8')).details.error,'recorder interrupted');
  assert.equal(new ClipStore(root).list().records[0].status,'pending');
  const data=fixture({keepsakesEnabled:true},202),original=fs.renameSync;
  fs.renameSync=(source,target)=>{if(path.dirname(target)===data.store.keepsakesDirectory){const error=new Error('synthetic disk full');error.code='ENOSPC';throw error;}return original(source,target);};
  try { assert.throws(()=>data.store.keep(data.record.id,'Recoverable copy'),/synthetic disk full/); }
  finally { fs.renameSync=original; }
  const status=data.store.status().keepsakes;assert.equal(status.pendingEntries,1);assert(status.usedBytes>0);
  assert(!fs.existsSync(path.join(data.store.keepsakesDirectory,'.write.lock')));
  const pending=fs.readdirSync(data.store.keepsakesDirectory).find(name=>name.startsWith('.pending-'));
  assert(pending);assert.deepEqual(fs.readFileSync(path.join(data.store.keepsakesDirectory,pending,'source.mkv')),data.video);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data.store.keepsakesDirectory,pending,'record.json'),'utf8')).title,'Recoverable copy');
  assert.throws(()=>data.store.keep(data.record.id,'No duplicate after uncertainty'),/REQUIRES_OWNER_INSPECTION/);
  const failedExport=path.join(data.root,'pending-export');assert.throws(()=>data.store.exportTo(failedExport),/REQUIRES_OWNER_INSPECTION/);
  assert(!fs.existsSync(failedExport));
});
