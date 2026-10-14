import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Store } from './src/store.mjs';
import { Controller } from './src/controller.mjs';
import { registerHttp } from './src/http.mjs';
import { registerLazySender } from './src/lazy-sender.mjs';
export const inject=['sessionController','credentials','connection','fileUploads','attachments','fs','tools','agents'];
export async function apply(ctx,config={}) {
  const root=process.env.DSH_HOME || join(homedir(),'.dsh');
  const profile=process.env.DSH_PROFILE||'default';
  if (!/^[a-z][a-z0-9-]*$/.test(profile)) {
    throw new TypeError('WeChat profile must use lowercase letters, numbers and hyphens');
  }
  const store=await Store.open(join(root,'storages','dsh-wechat',profile));
  let controller, offHttp, offTools;
  try {
    controller=new Controller(ctx,store,{cwd:resolve(config.cwd||process.cwd()),agentPreset:config.agentPreset||'standard',credentialKey:`dsh-wechat/${profile}`});
    offHttp=registerHttp(ctx,controller);
    offTools=registerLazySender(ctx,controller);
    ctx.effect(()=>async()=>{try {await offTools(); await offHttp();} finally {await controller.close();}});
    if(store.snapshot().enabled) {
      try {await controller.action('start');} catch(error) {controller.error=error.code||'startup-failed';}
    }
  }catch(error){await Promise.allSettled([offTools?.(),offHttp?.()]); if(controller) await controller.close(); else await store.close(); throw error;}
}
