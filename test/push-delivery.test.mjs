import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { Controller } from '../src/controller.mjs';
import { Store } from '../src/store.mjs';

async function fixture(t, sendText, { sendRetryDelaysMs = [10, 10, 10] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-push-delivery-'));
  const store = await Store.open(directory);
  await store.update(s => { s.enabled = true; s.binding = {ownerId:'owner',context:{token:'test-context',receivedAt:1}}; });
  let modelCalls = 0;
  const harness = { async submit() {modelCalls++;}, async createSession() {throw new Error('must not create WeChat session');} };
  const client = { sendText, getUpdates(_cursor, signal) {
    return new Promise((_, reject) => signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  } };
  const controller = new Controller({},store,{cwd:directory});
  const bridge = new Bridge({store,client,harness,ownerId:'owner',sendRetryDelaysMs});
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

test('an uncertain push failure is dropped at once: the provider may already hold it',async t=>{
  let sends=0;
  const f=await fixture(t,async()=>{sends++;throw Object.assign(new Error('response lost'),{uncertain:true});});
  const result=await f.controller.enqueueText('test',{sessionId:'web-session',callId:'uncertain'});
  await until(()=>f.store.snapshot().seen.includes(`\0outbox-failed\0${result.id}`));
  await f.bridge.stop();await f.bridge.start();
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(sends,1);
  assert.equal((await f.controller.enqueueText('test',{sessionId:'web-session',callId:'uncertain'})).status,'failed');
  assert.deepEqual(f.store.snapshot().outbox,[]);assert.equal(f.modelCalls,0);
});

test('a rejected push is retried until the provider accepts it',async t=>{
  const sent=[];
  let sends=0;
  const f=await fixture(t,async payload=>{
    sends++;
    if(sends<3) throw Object.assign(new Error('provider rejected'),{code:'provider-rejected',providerCode:'-1'});
    sent.push(payload);
  });
  const result=await f.controller.enqueueText('重试后送达',{sessionId:'web-session',callId:'retry'});
  await until(()=>f.store.snapshot().seen.includes(`\0outbox\0${result.id}`));
  assert.equal(sends,3);
  assert.equal(sent.length,1);
  assert.equal(sent[0].clientId,result.id);
  assert.equal(sent[0].text,'重试后送达');
  assert.deepEqual(f.store.snapshot().outbox,[]);
  assert.equal((await f.controller.enqueueText('重试后送达',{sessionId:'web-session',callId:'retry'})).status,'sent');
  assert.equal(sends,3);
});

test('a push that keeps failing is retried on every slot, then discarded',async t=>{
  let sends=0;
  const f=await fixture(t,async()=>{sends++;throw Object.assign(new Error('provider rejected'),{code:'provider-rejected',providerCode:'-1'});},{sendRetryDelaysMs:[10,10,10]});
  const result=await f.controller.enqueueText('永远失败',{sessionId:'web-session',callId:'exhausted'});
  await until(()=>f.store.snapshot().seen.includes(`\0outbox-failed\0${result.id}`));
  assert.equal(sends,4);
  assert.deepEqual(f.store.snapshot().outbox,[]);
  assert.equal(f.bridge.error,'send-failed');
  await f.bridge.stop();await f.bridge.start();
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(sends,4);
});

test('a retry uses the freshest bound context token',async t=>{
  const tokens=[];
  let store;
  const f=await fixture(t,async payload=>{
    tokens.push(payload.contextToken);
    if(tokens.length===1){
      await store.update(s=>{s.binding.context.token='fresh-context';});
      throw Object.assign(new Error('context expired'),{code:'provider-rejected',providerCode:'-1'});
    }
  });
  store=f.store;
  const result=await f.controller.enqueueText('刷新上下文',{sessionId:'web-session',callId:'refresh'});
  await until(()=>f.store.snapshot().seen.includes(`\0outbox\0${result.id}`));
  assert.deepEqual(tokens,['test-context','fresh-context']);
  assert.equal(tokens.length,2);
});

test('a stale context is retried once without the token, so an idle peer still gets the push',async t=>{
  const calls=[];
  const f=await fixture(t,async payload=>{
    calls.push(payload.contextToken);
    if(payload.contextToken) throw Object.assign(new Error('prepare failed'),{code:'provider-rejected',providerCode:'-2'});
  });
  const result=await f.controller.enqueueText('无 token 兜底',{sessionId:'web-session',callId:'stale'});
  await until(()=>f.store.snapshot().seen.includes(`\0outbox\0${result.id}`));
  assert.equal(calls.length,2);
  assert.equal(calls[0],'test-context');
  assert.equal(calls[1],'');
  assert.deepEqual(f.store.snapshot().outbox,[]);
  assert.equal(f.bridge.error,null);
});

test('a tokenless fallback that also fails is retried on the schedule, then discarded',async t=>{
  let sends=0;
  const f=await fixture(t,async()=>{
    sends++;
    throw Object.assign(new Error('prepare failed'),{code:'provider-rejected',providerCode:'-2'});
  },{sendRetryDelaysMs:[10,10,10]});
  const result=await f.controller.enqueueText('会话未就绪',{sessionId:'web-session',callId:'not-ready'});
  await until(()=>f.store.snapshot().seen.includes(`\0outbox-failed\0${result.id}`));
  assert.equal(sends,8);
  assert.deepEqual(f.store.snapshot().outbox,[]);
  assert.equal(f.bridge.error,'send-failed');
});
