import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { ILinkClient, normalizeMediaItems } from '../src/ilink.mjs';
const json=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});
for (const kind of ['image','file','video']) test(`complete ${kind} upload and stable final-send retry`,async()=>{
  const bytes=Buffer.from('payload-123');const calls=[];let first=true,key;
  const client=new ILinkClient({token:'secret',retryBaseMs:1,fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).includes('getuploadurl')){
      const body=JSON.parse(options.body);key=Buffer.from(body.aeskey,'hex');
      assert.equal(body.rawfilemd5,createHash('md5').update(bytes).digest('hex'));
      assert.equal(body.filesize,16);assert.equal(body.media_type,kind==='image'?1:3);
      return json({upload_full_url:null,upload_param:'upload-param'});
    }
    if(String(url).includes('/c2c/upload')){
      assert.equal(options.headers.Authorization,undefined);
      const decipher=createDecipheriv('aes-128-ecb',key,null);
      assert.deepEqual(Buffer.concat([decipher.update(options.body),decipher.final()]),bytes);
      return new Response('',{headers:{'x-encrypted-param':'download-param'}});
    }
    if(String(url).includes('sendmessage')){
      if(first){first=false;return json({ret:-2});}return json({ret:0});
    }
    throw Error('unexpected URL');
  }});
  await client.sendMedia({userId:'owner',contextToken:'ctx',clientId:'fixed-id',kind,name:'output.mp4',bytes});
  const sends=calls.filter(x=>x.url.includes('sendmessage'));
  assert.equal(sends.length,2);assert.equal(sends[0].options.body,sends[1].options.body);
  const item=JSON.parse(sends[0].options.body).msg.item_list[0];
  assert.equal(item.type,kind==='image'?2:4);
  if(kind!=='image')assert.equal(item.file_item.file_name,'output.mp4');
});
test('explicit plaintext media accepted only from allowlisted CDN',async()=>{
  const [desc]=normalizeMediaItems([{type:2,image_item:{media:{full_url:'https://novac2c.cdn.weixin.qq.com/c2c/download?p=x',encrypt_type:0}}}]);
  assert.equal(desc.media.encrypt_type,0);
  let fetched=0;
  const client=new ILinkClient({fetchImpl:async()=>{fetched++;return new Response('plain');}});
  assert.equal((await client.downloadMedia(desc)).toString(),'plain');
  await assert.rejects(client.downloadMedia({...desc,media:{...desc.media,full_url:'https://evil.example/c2c/download'}}),/untrusted-media-url/);
  assert.equal(fetched,1);
});
test('CDN upload failure is not uncertain message delivery',async()=>{
  let finalCalls=0;
  const client=new ILinkClient({fetchImpl:async(url)=>{
    if(String(url).includes('getuploadurl'))return json({upload_param:'u'});
    if(String(url).includes('sendmessage'))finalCalls++;
    throw Error('upload failed');
  }});
  await assert.rejects(client.sendMedia({userId:'u',contextToken:'c',clientId:'id',kind:'file',name:'f',bytes:Buffer.from('x')}),e=>e.code==='network-error'&&!e.uncertain);
  assert.equal(finalCalls,0);
});
test('zero-byte file encodes one padding block but empty image is rejected',async()=>{
  const client=new ILinkClient({fetchImpl:async(url,o)=>{
    if(String(url).includes('getuploadurl')){assert.equal(JSON.parse(o.body).rawsize,0);return json({upload_param:'u'});}
    if(String(url).includes('/c2c/upload')){assert.equal(o.body.length,16);return new Response('',{headers:{'x-encrypted-param':'d'}});}
    assert.equal(JSON.parse(o.body).msg.item_list[0].file_item.len,'0');return json({ret:0});
  }});
  await client.sendMedia({userId:'u',contextToken:'c',clientId:'id',kind:'file',name:'empty.txt',bytes:Buffer.alloc(0)});
  await assert.rejects(client.sendMedia({userId:'u',contextToken:'c',clientId:'id',kind:'image',bytes:Buffer.alloc(0)}),/Empty image/);
});


test('ambiguous final media send is attempted once', async () => {
  let attempts = 0;
  const client = new ILinkClient({fetchImpl:async url => {
    if(String(url).includes('getuploadurl')) return json({upload_param:'u'});
    if(String(url).includes('/c2c/upload')) return new Response('',{headers:{'x-encrypted-param':'d'}});
    attempts++; throw new Error('lost response');
  }});
  await assert.rejects(client.sendMedia({userId:'u',contextToken:'c',clientId:'id',kind:'file',name:'f',bytes:Buffer.from('x')}), error => error.uncertain);
  assert.equal(attempts, 1);
});
