import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const read = async file => JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
const directory = process.argv[2]
  ? path.resolve(process.argv[2]) : (await read('work/soak-active.json')).directory;
const run = await read(path.join(directory,'run.json'));
const raw = await read(path.join(directory,'gpu.json'));
if (run.status !== 'passed' || !Array.isArray(raw)) throw new Error('A passed soak run and its GPU sample array are required.');
const summary = {
  sourceRevision:run.revision, directory,
  method:'Maximum app-attributed physical GPU engine per sample; not whole-PC GPU utilization. Exclude two seconds after phase start to avoid a counter interval crossing the visibility transition. Missing or invalid target counters are excluded, never replaced with zero.',
};
for (const name of ['visible','hidden']) {
  const phase=run.phases.find(value=>value.name===name)?.summary;
  if (!phase) throw new Error(`Missing phase ${name}`);
  const start=Date.parse(phase.start)+2000, end=Date.parse(phase.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end<=start) throw new Error('Invalid phase timestamps.');
  let previous=-Infinity, rejected=0;
  const values=[];
  for (const sample of raw) {
    const time=Date.parse(sample.time);
    if (!Number.isFinite(time) || time<=previous) throw new Error('GPU timestamps must strictly increase.');
    previous=time;
    if (time<start || time>end) continue;
    const engines=Object.values(sample.engines??{});
    const valid=value=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=100;
    if (sample.available!==true || !engines.length || !engines.every(valid) || !valid(sample.busiestEnginePercent)
      || Math.abs(Math.max(...engines)-sample.busiestEnginePercent)>1e-6) { rejected++;continue; }
    values.push({time,value:sample.busiestEnginePercent});
  }
  if (values.length<2) throw new Error(`${name}: not enough valid GPU samples (${rejected} rejected).`);
  const gaps=values.slice(1).map((value,index)=>(value.time-values[index].time)/1000);
  summary[name]={mean:values.reduce((sum,sample)=>sum+sample.value,0)/values.length,
    max:Math.max(...values.map(sample=>sample.value)),samples:values.length,rejectedSamples:rejected,
    start:new Date(values[0].time).toISOString(),end:new Date(values.at(-1).time).toISOString(),
    spanSeconds:(values.at(-1).time-values[0].time)/1000,maxGapSeconds:Math.max(...gaps)};
}
await writeFile(path.join(directory,'gpu-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
