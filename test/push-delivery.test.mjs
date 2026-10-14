import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { Controller } from '../src/controller.mjs';
import { Store } from '../src/store.mjs';

async function fixture(t, sendText) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-push-delivery-'));
  const store = await Store.open(directory);
  await store.update(s => { s.enabled = true; s.binding = {ownerId:'owner',context:{token:'test-context',receivedAt:1}}; });
  let modelCalls = 0;
  const harness = { async submit() {modelCalls++;}, async createSession() {throw new Error('must not create WeChat session');} };
  const client = { sendText, getUpdates(_cursor, signal) {
    return new Promise((_, reject) => signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  } };
  const controller = new Controller({},store,{cwd:directory});
  const bridge = new Bridge({store,client,harness,ownerId:'owner'});
  controller.bridge = bridge;
  await bridge.start();
  t.after(async()=>{await controller.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,controller,bridge,get modelCalls(){return modelCalls;}};
}
async function until(fn) {
  const end=Date.now()+4000;
  while(!fn()) {if(Date.now()>end)throw new Error('delivery condition timeout');await new Promise(resolve=>setTimeout(resolve,10));}
}

test('a Web-origin push is delivered by the existing worker without model admission or changing WeChat session', async t => {
  const sent=[];
  const f=await fixture(t,async payload=>sent.push(payload));
  const result=await f.controller.enqueueText('完成通知',{sessionId:'web-session',callId:'notify'});
  await until(()=>f.store.snapshot().seen.includes(`\0outbox\0${result.id}`));
  assert.equal(sent.length,1);
  assert.equal(sent[0].userId,'owner');assert.equal(sent[0].contextToken,'test-context');
  assert.equal(sent[0].clientId,result.id);assert.equal(sent[0].text,'完成通知');
  assert.equal(f.modelCalls,0);assert.equal(f.store.snapshot().sessionId,null);
  assert.equal((await f.controller.enqueueText('完成通知',{sessionId:'web-session',callId:'notify'})).status,'sent');
  assert.equal(sent.length,1);
});

for(const uncertain of [true,false]) {
  test(`push failure (uncertain=${uncertain}) is discarded and never automatically repeated`,async t=>{
    let sends=0;
    const f=await fixture(t,async()=>{sends++;throw Object.assign(new Error('provider failure'),{uncertain});});
    const result=await f.controller.enqueueText('test',{sessionId:'web-session',callId:'failure'});
    await until(()=>f.store.snapshot().seen.includes(`\0outbox-failed\0${result.id}`));
    await f.bridge.stop();await f.bridge.start();
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(sends,1);
    assert.equal((await f.controller.enqueueText('test',{sessionId:'web-session',callId:'failure'})).status,'failed');
    assert.deepEqual(f.store.snapshot().outbox,[]);assert.equal(f.modelCalls,0);
  });
}
