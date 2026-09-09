import { readFile, writeFile } from 'node:fs/promises';
const read = async file => JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
const samples = await read('work/metrics.json');
const periods = await read('work/measurement-periods.json');
const cores = 16; // This evaluation machine; change for a different machine.
const stats = data => ({mean:data.reduce((a,b)=>a+b,0)/data.length,min:Math.min(...data),max:Math.max(...data),samples:data.length});
function summarize(start,end,visible) {
  const rows=samples.filter(s=>s.visible===visible && Date.parse(s.time)>=Date.parse(start)+10000 && Date.parse(s.time)<=Date.parse(end));
  if(rows.length<2)throw new Error('Not enough matching samples');
  const cpu=[];
  for(let i=1;i<rows.length;i++) {
    const a=rows[i-1],b=rows[i];
    let seconds=0;
    for(const process of b.processes) {
      const prior=a.processes.find(p=>p.pid===process.pid);
      if(prior)seconds+=Math.max(0,process.cpu.cumulativeCPUUsage-prior.cpu.cumulativeCPUUsage);
    }
    cpu.push(seconds/((Date.parse(b.time)-Date.parse(a.time))/1000)/cores*100);
  }
  return {start:rows[0].time,end:rows.at(-1).time,cpuPercentOfPC:stats(cpu),workingSetMiB:stats(rows.map(r=>r.processes.reduce((s,p)=>s+p.memory.workingSetSize,0)/1024)),privateMiB:stats(rows.map(r=>r.processes.reduce((s,p)=>s+(p.memory.privateBytes??0),0)/1024))};
}
const visibleGpu=await read('work/gpu-visible-final.json');
const hiddenGpu=await read('work/gpu-hidden-final.json');
const summary={cores,visible:summarize(periods.visibleStart,periods.visibleEnd,true),hidden:summarize(periods.hiddenStart,periods.hiddenEnd,false),visibleGpuPercent:stats(visibleGpu.map(s=>s.busiestEnginePercent).filter(n=>n!==null)),hiddenGpuPercent:stats(hiddenGpu.map(s=>s.busiestEnginePercent).filter(n=>n!==null)),diagnostics:periods.finalDiagnostics};
await writeFile('work/performance-summary.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
