// Own Electron windows only. These checks do not certify physical input focus.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const before=await readFile(path.join(root,'local.config.json'));
const cfg=JSON.parse(before.toString().replace(/^\uFEFF/,''));
const directory=await mkdtemp(path.join(root,'work','postures-'));
await writeFile(path.join(directory,'local.config.json'),JSON.stringify({modelPath:cfg.modelPath,scale:100,posture:'unknown-old-setting'}));
let application,page;const pids=new Set();const results=[];const frames=[];let failure;
let fullBodyDrawCalls;
const inspect=fn=>application.evaluate(fn);
const diag=()=>page.evaluate(()=>({...window.__diagnostics}));
const waitPose=async posture=>page.waitForFunction(p=>window.__diagnostics.posture===p&&!window.__diagnostics.changingPosture&&window.__diagnostics.loaded,posture,{timeout:8000});
const recordPids=async()=>{pids.add(application.process().pid);for(const p of await inspect(()=>globalThis.__shizuku.metrics()))pids.add(p.pid);};
async function launch(){
 application=await _electron.launch({executablePath:electron,args:[root],cwd:root,env:{...process.env,SHIZUKU_TEST:'1',SHIZUKU_TEST_DATA:path.basename(directory)}});
 page=await application.firstWindow();await page.waitForFunction(()=>window.__diagnostics?.loaded);
 await recordPids();
}
async function capture(name){
 const frame=await inspect(async()=>{
  const img=await globalThis.__shizuku.avatar().webContents.capturePage();const bytes=img.toBitmap();const {width,height}=img.getSize();
  let minX=width,minY=height,maxX=-1,maxY=-1,opaque=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(bytes[(y*width+x)*4+3]){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);opaque++;}
  return {width,height,minX,minY,maxX,maxY,opaque,png:img.toPNG().toString('base64')};
 });
 const {png,...data}=frame;assert.ok(data.opaque>100);assert.ok(data.minX>1&&data.minY>1&&data.maxX<data.width-2&&data.maxY<data.height-2,'Body must not hit canvas edges');
 await writeFile(path.join(directory,name+'.png'),Buffer.from(png,'base64'));
 const state=await diag();
 fullBodyDrawCalls??=state.drawCalls;
 assert.equal(state.drawCalls,fullBodyDrawCalls,'A fully framed posture must not omit any body-part draw calls (such as shoes)');
 frames.push({name,...data,blend:state.postureBlend,changing:state.changingPosture,drawCalls:state.drawCalls});
 return data;
}
try {
 await launch();await waitPose('standing');await page.emulateMedia({reducedMotion:'no-preference'});
 assert.equal(await inspect(()=>globalThis.__shizuku.status().posture),'standing');
 const standingFrame=await capture('standing');
 const opened=application.waitForEvent('window');
 await inspect(()=>globalThis.__shizuku.openControls());
 const controls=await opened;await controls.waitForSelector('input[name="posture"]');
 await controls.locator('input[name="posture"][value="sitting"]').check();
 for(let i=0;i<5;i++){await delay(100);await capture('transition-'+i);}
 await waitPose('sitting');const sittingFrame=await capture('sitting');
 assert.ok((sittingFrame.maxY-sittingFrame.minY)<(standingFrame.maxY-standingFrame.minY)*0.9,'Sitting must shorten the silhouette instead of enlarging the body to fill the canvas');
 assert.ok(Math.abs(sittingFrame.maxY-standingFrame.maxY)<=5,'Feet should stay at the same displayed baseline');
 assert.equal(await controls.locator('input[name="posture"][value="sitting"]').isChecked(),true);
 assert.equal(await inspect(()=>globalThis.__shizuku.avatar().isFocusable()),false);
 const overflow=await controls.evaluate(()=>({wide:document.documentElement.scrollWidth>innerWidth,postures:[...document.querySelectorAll('input[name="posture"]')].every(el=>el.getBoundingClientRect().bottom<innerHeight)}));
 assert.deepEqual(overflow,{wide:false,postures:true});
 await controls.screenshot({path:path.join(directory,'controls.png')});
 results.push('Old settings default to standing; controls radio animates to sitting; captured body stays inside canvas; controls fit.');
 await inspect(()=>globalThis.__shizuku.action('call'));await page.waitForFunction(()=>window.__diagnostics.reacting);
 await delay(600);await capture('sitting-called');await page.waitForFunction(()=>!window.__diagnostics.reacting);
 assert.equal((await diag()).posture,'sitting');
 results.push('Sitting keeps the finite call response and remains nonfocusable.');
 await inspect(()=>globalThis.__shizuku.setMoveMode(true));await page.waitForFunction(()=>window.__diagnostics.moving);
 await delay(150);assert.ok(await inspect(()=>globalThis.__shizuku.moveState().shape.length)>0);
 await inspect(()=>globalThis.__shizuku.setPosture('standing'));await waitPose('standing');
 assert.equal(await inspect(()=>globalThis.__shizuku.moveState().active),false);
 assert.deepEqual(await inspect(()=>globalThis.__shizuku.moveState().shape),[]);
 await inspect(()=>globalThis.__shizuku.setPosture('sitting'));await delay(180);
 await inspect(()=>globalThis.__shizuku.setMoveMode(true));await page.waitForFunction(()=>window.__diagnostics.moving);
 const frozen=await diag();await delay(200);
 assert.equal((await diag()).postureBlend,frozen.postureBlend);assert.equal((await diag()).renderedFrames,frozen.renderedFrames);
 await inspect(()=>globalThis.__shizuku.setMoveMode(false));await waitPose('sitting');
 await inspect(()=>globalThis.__shizuku.setPosture('standing'));await waitPose('standing');
 await inspect(()=>globalThis.__shizuku.setPosture('sitting'));await delay(180);
 const partial=(await diag()).postureBlend;assert.ok(partial>0&&partial<1);
 await inspect(()=>globalThis.__shizuku.setPosture('standing'));await waitPose('standing');
 assert.equal((await diag()).postureBlend,0);
 results.push('Posture changes release old move regions; moving freezes a transition and resumes it afterward; reversing finishes at the requested pose.');
 await inspect(()=>globalThis.__shizuku.setVisible(false));await page.waitForFunction(()=>!window.__diagnostics.visible);
 const hiddenFrames=(await diag()).renderedFrames;
 await inspect(()=>globalThis.__shizuku.setPosture('sitting'));await delay(200);
 assert.equal((await diag()).renderedFrames,hiddenFrames);assert.equal((await diag()).postureBlend,1);assert.equal((await diag()).changingPosture,false);
 await inspect(()=>globalThis.__shizuku.setVisible(true));await waitPose('sitting');await capture('sitting-after-show');
 results.push('A hidden posture change settles without rendering or revealing the window; show draws the selected pose.');
 await page.emulateMedia({reducedMotion:'reduce'});await delay(100);
 const beforeStill=(await diag()).renderedFrames;
 await inspect(()=>globalThis.__shizuku.setPosture('standing'));await waitPose('standing');await delay(100);
 assert.equal((await diag()).renderedFrames,beforeStill+1);assert.equal((await diag()).animating,false);
 const still=(await diag()).renderedFrames;await delay(250);assert.equal((await diag()).renderedFrames,still);
 await inspect(()=>globalThis.__shizuku.setPosture('sitting'));await waitPose('sitting');await capture('sitting-reduced-motion');
 results.push('Reduced motion changes pose in one frame with no repeating timer.');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{window.__poseContext=document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context');window.__poseContext.loseContext();});
 await page.waitForFunction(()=>window.__diagnostics.contextLost);
 await inspect(()=>globalThis.__shizuku.setPosture('standing'));await delay(100);
 const lost=(await diag()).renderedFrames;await delay(150);assert.equal((await diag()).renderedFrames,lost);
 await page.evaluate(()=>window.__poseContext.restoreContext());await page.waitForFunction(()=>!window.__diagnostics.contextLost);await waitPose('standing');
 results.push('Posture choices during context loss wait for restoration and then complete.');
 await inspect(()=>globalThis.__shizuku.setPosture('sitting'));await waitPose('sitting');
 for(const scale of [80,120,100]){await application.evaluate((_e,n)=>globalThis.__shizuku.setScale(n),scale);await delay(150);await capture('sitting-size-'+scale);}
 await inspect(()=>globalThis.__shizuku.avatar().webContents.send('model:changed'));await delay(150);await waitPose('sitting');
 await capture('sitting-after-reload');
 await assert.rejects(inspect(()=>globalThis.__shizuku.setPosture('invalid')));
 await assert.rejects(page.evaluate(()=>window.companion.action('stand')));
 results.push('Sitting fits all sizes and survives model reload; invalid posture and renderer action IPC are rejected.');
 await recordPids();await application.close();application=null;
 await launch();await waitPose('sitting');await capture('sitting-after-restart');
 assert.equal(await inspect(()=>globalThis.__shizuku.status().posture),'sitting');
 await recordPids();await application.close();application=null;
 results.push('Selected posture persists through normal shutdown and restart.');
}catch(error){failure=error;}finally{
 if(application){try{await recordPids();await application.close();}catch(error){failure??=error;}}
 let remaining=[];for(let i=0;i<20;i++){remaining=[...pids].filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});if(!remaining.length)break;await delay(250);}
 const settingsUnchanged=(await readFile(path.join(root,'local.config.json'))).equals(before);
 if(remaining.length||!settingsUnchanged)failure??=new Error('Processes remain or normal settings changed');
 await writeFile(path.join(directory,'result.json'),JSON.stringify({status:failure?'failed':'passed',date:new Date().toISOString(),results,frames,remainingPids:remaining,settingsUnchanged,error:failure?.stack},null,2));
 console.log(JSON.stringify({directory,passed:results.length,status:failure?'failed':'passed',remainingPids:remaining,settingsUnchanged,error:failure?.message},null,2));
}
if(failure)throw failure;
