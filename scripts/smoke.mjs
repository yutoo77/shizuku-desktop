// Native Electron API + renderer smoke. Physical mouse/keyboard tests remain separate.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'work'), {recursive:true});
const results = [];
let application;
try {
  application = await _electron.launch({executablePath:electron,args:[root],cwd:root,env:{...process.env,SHIZUKU_TEST:'1'}});
  const page = await application.firstWindow();
  await page.waitForFunction(()=>window.__diagnostics?.loaded, null, {timeout:20000});
  const inspect = fn => application.evaluate(fn);
  assert.equal(await inspect(()=>globalThis.__shizuku.avatar().isFocusable()),false);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.equal(await page.evaluate(()=>typeof window.process),'undefined');
  const blocked = await page.evaluate(async()=>{try{await fetch('https://example.com/');return false;}catch{return true;}});
  assert.equal(blocked,true);
  results.push('VRM loaded; overlay nonfocusable; renderer has no Node; external fetch blocked');

  await inspect(()=>globalThis.__shizuku.setVisible(false));
  await delay(200);
  const hiddenFrames = await page.evaluate(()=>window.__diagnostics.renderedFrames);
  await delay(600);
  assert.equal(await page.evaluate(()=>window.__diagnostics.renderedFrames),hiddenFrames);
  assert.equal(await inspect(()=>globalThis.__shizuku.avatar().isVisible()),false);
  await inspect(()=>globalThis.__shizuku.setVisible(true));
  await page.waitForFunction(n=>window.__diagnostics.renderedFrames>n,hiddenFrames);
  results.push('Hide stops rendering; show resumes');

  await page.emulateMedia({reducedMotion:'reduce'});
  await delay(200);
  const stillFrames = await page.evaluate(()=>window.__diagnostics.renderedFrames);
  await delay(400);
  assert.equal(await page.evaluate(()=>window.__diagnostics.renderedFrames),stillFrames);
  await page.emulateMedia({reducedMotion:'no-preference'});
  results.push('Reduced motion stops repeating timer');

  const bitmap = await inspect(async()=>{
    const image=await globalThis.__shizuku.avatar().webContents.capturePage();
    const data=image.toBitmap();let transparent=0,opaque=0;
    for(let i=3;i<data.length;i+=4){if(data[i]===0)transparent++;if(data[i]>0)opaque++;}
    return {transparent,opaque};
  });
  assert.ok(bitmap.transparent>100 && bitmap.opaque>100);
  results.push('Native capture contains both transparent pixels and visible model');

  const escaped=await page.evaluate(async()=>{try{await window.companion.action('quit');return true;}catch{return false;}});
  assert.equal(escaped,false);
  await inspect(()=>globalThis.__shizuku.openControls());
  await delay(250);
  const control=application.windows().find(p=>p.url().endsWith('controls.html'));
  assert.ok(control);
  const modelAccess=await control.evaluate(async()=>{try{await window.companion.getModel();return true;}catch{return false;}});
  assert.equal(modelAccess,false);
  await control.getByRole('button',{name:'画面端に戻す',exact:true}).click();
  await delay(200);
  const before=await inspect(()=>globalThis.__shizuku.avatar().getBounds());
  await control.getByRole('button',{name:'左へ',exact:true}).click();
  await delay(150);
  const after=await inspect(()=>globalThis.__shizuku.avatar().getBounds());
  assert.equal(after.x,before.x-16);
  results.push('Control nudge moves native window; cross-window IPC denied');
  await inspect(()=>globalThis.__shizuku.controls().close());

  const pressTray = async label => {
    await application.evaluate((_electron, text)=>{
      const item=globalThis.__shizuku.trayMenu().items.find(i=>i.label===text);
      if(!item)throw new Error(`Missing tray item: ${text}`);
      item.click();
    },label);
    await delay(50);
  };
  assert.equal(await inspect(()=>globalThis.__shizuku.tray().isDestroyed()),false);
  await pressTray('隠す');
  assert.equal(await inspect(()=>globalThis.__shizuku.avatar().isVisible()),false);
  await pressTray('表示する');
  assert.equal(await inspect(()=>globalThis.__shizuku.avatar().isVisible()),true);
  await inspect(()=>globalThis.__shizuku.tray().emit('double-click'));
  assert.equal(await inspect(()=>globalThis.__shizuku.avatar().isVisible()),false);
  await inspect(()=>globalThis.__shizuku.tray().emit('double-click'));
  assert.equal(await inspect(()=>globalThis.__shizuku.avatar().isVisible()),true);
  await pressTray('位置を動かす…');
  await inspect(()=>{const s=globalThis.__shizuku;s.controls().close();s.openControls();});
  await delay(150);
  assert.equal(await inspect(()=>!!globalThis.__shizuku.controls()),true,'Rapid close/reopen must not reuse a closing controls window');
  await inspect(({dialog})=>{
    globalThis.__originalOpenDialog=dialog.showOpenDialog;
    dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});
    globalThis.__shizuku.trayMenu().items.find(i=>i.label==='VRMを選ぶ…').click();
  });
  await delay(200);
  assert.equal(await inspect(()=>globalThis.__shizuku.status().modelLoaded),true);
  assert.equal(await inspect(()=>!!globalThis.__shizuku.controls()),true,'New controls survive the previous controls close event');
  await inspect(({dialog})=>{dialog.showOpenDialog=globalThis.__originalOpenDialog;delete globalThis.__originalOpenDialog;globalThis.__shizuku.controls().close();});
  results.push('Actual Electron tray menu callbacks hide/show/open controls; double-click event toggles; model-dialog cancel preserves model (not physical input)');

  await inspect(()=>globalThis.__shizuku.avatar().setPosition(-9000,-9000));
  await delay(150);
  await inspect(()=>globalThis.__shizuku.trayMenu().items.find(i=>i.label==='画面端に戻す').click());
  await delay(300);
  const recovery=await inspect(({screen})=>({actual:globalThis.__shizuku.avatar().getBounds(),area:screen.getPrimaryDisplay().workArea}));
  assert.deepEqual(recovery.actual,{x:recovery.area.x+recovery.area.width-300-24,y:recovery.area.y+recovery.area.height-440-12,width:300,height:440});
  results.push('Recovery restores fixed 300x440 size and primary-screen margins after distant offscreen position');
  const diagnostics=await page.evaluate(()=>window.__diagnostics);
  const pids=(await inspect(()=>globalThis.__shizuku.metrics())).map(p=>p.pid);
  const closed=application.waitForEvent('close');
  await inspect(()=>{globalThis.__shizuku.trayMenu().items.find(i=>i.label==='終了').click();});
  await closed;application=null;
  await delay(1000);
  const remaining=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
  assert.deepEqual(remaining,[]);
  results.push('Tray menu exit callback flushes state and all recorded app processes exit');
  await writeFile(path.join(root,'work/smoke.json'),JSON.stringify({date:new Date().toISOString(),results,bitmap,recovery,diagnostics,remaining},null,2));
  console.log(JSON.stringify({passed:results.length,results},null,2));
} finally { if(application) await application.close(); }
