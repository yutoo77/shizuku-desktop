// Exercise real ImageBitmaps in the selected local VRM; no model copies or UI input.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const before=await readFile(path.join(root,'local.config.json'));
const config=JSON.parse(before.toString('utf8').replace(/^\uFEFF/,''));
const directory=await mkdtemp(path.join(root,'work','resources-'));
await writeFile(path.join(directory,'local.config.json'),JSON.stringify({modelPath:config.modelPath,scale:100}));
let application;
let pids=[];
const results=[];
try {
  application=await _electron.launch({executablePath:electron,args:[root],cwd:root,
    env:{...process.env,SHIZUKU_TEST:'1',SHIZUKU_TEST_DATA:path.basename(directory)}});
  const page=await application.firstWindow();
  await page.waitForFunction(()=>window.__diagnostics?.loaded,null,{timeout:20_000});
  pids=(await application.evaluate(()=>globalThis.__shizuku.metrics())).map(p=>p.pid);
  await page.evaluate(()=>{
    const create=window.createImageBitmap;
    const close=ImageBitmap.prototype.close;
    const ids=new WeakMap();
    const probe={generation:0,hold:false,pending:[],images:[]};
    window.__bitmapProbe=probe;
    window.createImageBitmap=async function(...args){
      const generation=probe.generation;
      const bitmap=await create.apply(this,args);
      const record={id:probe.images.length,generation,width:bitmap.width,height:bitmap.height,closed:0};
      probe.images.push(record);ids.set(bitmap,record);
      if(probe.hold)await new Promise(resolve=>probe.pending.push(resolve));
      return bitmap;
    };
    ImageBitmap.prototype.close=function(){const record=ids.get(this);if(record)record.closed++;return close.call(this);};
  });
  const snapshots=()=>page.evaluate(()=>({images:window.__bitmapProbe.images.map(x=>({...x})),textures:window.__diagnostics.textures}));
  const beginReload=async generation=>{
    await page.evaluate(n=>{window.__bitmapProbe.generation=n;},generation);
    await application.evaluate(()=>globalThis.__shizuku.avatar().webContents.send('model:changed'));
  };
  const waitLoaded=async generation=>page.waitForFunction(n=>window.__diagnostics.loaded&&window.__bitmapProbe.images.some(x=>x.generation===n),generation,{timeout:20_000});
  let perModel;
  for(let generation=1;generation<=3;generation++){
    await beginReload(generation);
    await waitLoaded(generation);
    const state=await snapshots();
    const current=state.images.filter(x=>x.generation===generation);
    assert.ok(current.length>0,'Resource checks require a VRM using ImageBitmap textures.');
    perModel??=current.length;
    assert.equal(current.length,perModel);
    assert.ok(current.every(x=>x.closed===0),'Current model images must remain usable.');
    assert.ok(state.images.filter(x=>x.generation<generation).every(x=>x.closed===1),'Discarded model images must be closed once.');
    results.push({generation,created:state.images.length,closed:state.images.filter(x=>x.closed===1).length,open:current.length,textures:state.textures});
  }
  // Hold decoded images from one model until a newer load has completed.
  await page.evaluate(()=>{window.__bitmapProbe.hold=true;});
  await beginReload(4);
  await page.waitForFunction(()=>window.__bitmapProbe.pending.length>0,null,{timeout:10_000});
  await page.evaluate(()=>{window.__bitmapProbe.hold=false;});
  await beginReload(5);
  await waitLoaded(5);
  const currentIds=(await snapshots()).images.filter(x=>x.generation===5 && x.closed===0).map(x=>x.id);
  assert.equal(currentIds.length,perModel);
  await page.evaluate(()=>{for(const resolve of window.__bitmapProbe.pending.splice(0))resolve();});
  await page.waitForFunction(()=>window.__bitmapProbe.images.filter(x=>x.generation===4).every(x=>x.closed===1),null,{timeout:10_000});
  // The obsolete parser may start later texture stages after its held callbacks.
  // Identify the already-complete current model by image IDs, not a global label.
  await delay(1000);
  const overlap=await snapshots();
  assert.ok(overlap.images.filter(x=>currentIds.includes(x.id)).every(x=>x.closed===0));
  assert.ok(overlap.images.filter(x=>!currentIds.includes(x.id)).every(x=>x.closed===1));
  assert.equal(await page.evaluate(()=>window.__diagnostics.loaded),true);
  const image=await application.evaluate(async()=> (await globalThis.__shizuku.avatar().webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(directory,'after-reloads.png'),Buffer.from(image,'base64'));
  // Empty input exercises clear without changing the real user's saved selection.
  await application.evaluate(({ipcMain})=>{
    ipcMain.removeHandler('model:read');
    ipcMain.handle('model:read',()=>null);
    globalThis.__shizuku.avatar().webContents.send('model:changed');
  });
  await page.waitForFunction(()=>!window.__diagnostics.loaded && window.__bitmapProbe.images.every(x=>x.closed===1),null,{timeout:5000});
  const cleared=await snapshots();
  await application.close();application=null;
  await delay(750);
  assert.deepEqual(pids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}}),[]);
  assert.ok((await readFile(path.join(root,'local.config.json'))).equals(before));
  const report={results,perModel,overlap:{created:overlap.images.length,closed:overlap.images.filter(x=>x.closed===1).length,open:overlap.images.filter(x=>x.closed===0).length},cleared:cleared.images.length,remainingPids:[],userSettingsUnchanged:true};
  await writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({directory,...report},null,2));
}finally{if(application)await application.close();}
