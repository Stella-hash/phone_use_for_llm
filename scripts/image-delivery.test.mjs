import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { prepareImage, boundResultImages, IMAGE_BYTE_LIMIT } from '../dist/image-delivery.js';

test('image preview bounds noisy payloads, preserves originals and declares coordinate mapping', () => {
  const width=1200,height=2400,data=Buffer.alloc(width*height*4);
  let seed=31;
  for(let i=0;i<data.length;i+=4){for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i+c]=seed>>>24;} data[i+3]=255;}
  const input=PNG.sync.write({width,height,data});
  const original=Buffer.from(input);
  assert(input.length>IMAGE_BYTE_LIMIT);
  const {bytes,metadata}=prepareImage(input,1600);
  assert(bytes.length<=IMAGE_BYTE_LIMIT);
  const decoded=PNG.sync.read(bytes);
  assert.equal(decoded.width,metadata.returned.width);assert.equal(decoded.height,metadata.returned.height);
  assert.equal(metadata.coordinateScale.x,width/decoded.width);assert.equal(metadata.coordinateScale.y,height/decoded.height);
  assert(Math.max(decoded.width,decoded.height)<=1600);
  assert(input.equals(original));
});

test('small images retain exact bytes; image failure preserves the text action result',()=>{
  const input=PNG.sync.write({width:1,height:1,data:Buffer.from([21,43,65,255])});
  assert.equal(prepareImage(input).bytes,input);
  const result={content:[{type:'text',text:'input acknowledged'},{type:'image',mimeType:'image/png',data:Buffer.from('invalid').toString('base64')}]};
  assert.equal(boundResultImages(result,123),false);
  assert.equal(result.content[0].text,'input acknowledged');
  assert.equal(result.isError,undefined);
  assert.equal(JSON.parse(result.content[1].text).phoneImage.status,'unavailable');
});

test('explicit smaller previews preserve color/alpha; deferred mode emits no image',()=>{
  const width=600,height=300,data=Buffer.alloc(width*height*4);
  for(let i=0;i<data.length;i+=4){data[i]=33;data[i+1]=66;data[i+2]=99;data[i+3]=123;}
  const input=PNG.sync.write({width,height,data});
  const {bytes,metadata}=prepareImage(input,256);
  assert.equal(metadata.returned.width,256);assert.equal(metadata.returned.height,128);
  assert.deepEqual(PNG.sync.read(bytes).data.subarray(0,4),Buffer.from([33,66,99,123]));
  const result={content:[{type:'image',mimeType:'image/png',data:input.toString('base64')}]};
  assert.equal(boundResultImages(result,77,256,true),false);
  assert.deepEqual(JSON.parse(result.content[0].text),{phoneImage:{status:'deferred',sourceEventId:77}});
});
