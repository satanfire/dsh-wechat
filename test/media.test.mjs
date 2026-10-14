import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaHandler } from '../src/media.mjs';
const image = Buffer.from([255,216,255,0,1]);
function handler(bytes=image) {
  const uploaded=[];
  const media=new MediaHandler({client:{async downloadMedia(){return bytes;}},fileUploads:{async uploadStream(request){
    const chunks=[];for await(const c of request.data) chunks.push(c);
    uploaded.push({name:request.name,bytes:Buffer.concat(chunks)});
    return {receiptId:`r${uploaded.length}`};
  }}});
  return {media,uploaded};
}
test('image bytes become validated DSH image input',async()=>{
  const {media,uploaded}=handler();
  const parts=await media.prepare({text:'分析图片',sourceKind:'text',media:[{kind:'image',media:{aes_key:'x'}}]},'session-x');
  assert.deepEqual(parts,[{type:'text',text:'分析图片'},{type:'image',mediaType:'image/jpeg',data:image.toString('base64'),name:'wechat-image-1.jpeg'}]);
  assert.equal(uploaded.length,0);
});
test('file and video use staged DSH file receipts, never host workspace paths',async()=>{
  const bytes=Buffer.from('data');const {media,uploaded}=handler(bytes);
  const parts=await media.prepare({text:'[收到媒体附件]',sourceKind:'media',media:[{kind:'file',name:'../../secret.txt'},{kind:'video'}]},'session-x');
  assert.equal(parts[1].type,'file');assert.equal(parts[1].receiptId,'r1');
  assert.equal(uploaded[0].name,'.._.._secret.txt');assert.deepEqual(uploaded[0].bytes,bytes);
  assert.equal(uploaded[1].name,'wechat-video-2.mp4');assert.equal(parts[2].type,'file');assert.match(parts[3].text,/视频文件/);
});
test('rejects malformed images, oversize media and excessive items',async()=>{
  const {media}=handler(Buffer.from('not image'));
  await assert.rejects(media.prepare({text:'x',media:[{kind:'image'}]},'s'),/Unrecognized image/);
  const large=handler(Buffer.alloc(8)).media;
  await assert.rejects(large.prepare({text:'x',media:[{kind:'file',size:50*1024*1024+1}]},'s'),/too large/);
  await assert.rejects(large.prepare({text:'x',media:Array(9).fill({kind:'image'})},'s'),/Too many/);
});
