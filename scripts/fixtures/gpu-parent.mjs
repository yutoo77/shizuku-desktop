// Sacrificial test driver for verifying that its worker exits with its parent.
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { startGpuCollector } from '../gpu-collector.mjs';
delete process.env.OPENAI_API_KEY;
const directory = process.argv[2];
const collector = await startGpuCollector({ pids: [process.pid], samples: 60, output: path.join(directory, 'parent-samples.json') });
await writeFile(path.join(directory, 'parent-worker.json'), JSON.stringify({ parentPid: process.pid, pid: collector.pid, directory: collector.directory }));
for (let i = 0; i < 400; i++) {
  if (await readFile(path.join(directory, 'exit-parent')).then(() => true, () => false)) process.exit(0);
  await delay(50);
}
await collector.stop(); await collector.done; process.exitCode = 1;
