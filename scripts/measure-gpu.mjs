import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildGpuHelper, startGpuCollector } from './gpu-collector.mjs';

// Explicit command only. No live provider/key is needed or inherited by helpers.
delete process.env.OPENAI_API_KEY;
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--build-only') {
  const directory = path.resolve('work/gpu-build'); await mkdir(directory, { recursive: true });
  await buildGpuHelper(directory); console.log('GPU measurement helper compiled; no counters sampled.');
} else {
  if (args.length !== 6 || args[0] !== '--samples' || args[2] !== '--pids-file' || args[4] !== '--output') throw new Error('Use --samples N --pids-file PATH --output PATH, or --build-only.');
  const pids = JSON.parse((await readFile(args[3], 'utf8')).replace(/^\uFEFF/, ''));
  const collector = await startGpuCollector({ samples: Number(args[1]), pids, output: args[5] });
  const stop = () => { void collector.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const result = await collector.done;
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  console.log(JSON.stringify({ status: result.status, measurementStatus: result.measurementStatus, ...result.summary, directory: result.directory }));
  if (result.status !== 'completed' || result.measurementStatus !== 'available') process.exitCode = 1;
}
