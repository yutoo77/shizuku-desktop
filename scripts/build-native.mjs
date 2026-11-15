import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export async function buildNative() {
  if (process.platform !== 'win32') return;
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = path.resolve('native', 'WindowTracker.cs'), output = path.resolve('dist', 'window-tracker.exe');
  const [input, previous] = await Promise.all([stat(source), stat(output).catch(() => null)]);
  if (previous && previous.mtimeMs >= input.mtimeMs) return;
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Windows.Forms.dll', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Windowsの.NET Framework C#コンパイラーで補助プログラムを作れませんでした。\n' + (result.stdout || result.error?.message || ''));
}
