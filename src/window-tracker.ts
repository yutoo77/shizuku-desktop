import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseWindowEvent } from './follow-policy.mjs';

export type TrackedWindow = { type: 'window'; id: number; state: 'visible' | 'minimized' | 'hidden'; x: number; y: number; width: number; height: number; sourceId: string; topmost: boolean; adjacent: boolean; orderVersion: number };
export type TrackingEvent = TrackedWindow | { type: 'end'; id: number; reason: string };
export type FixtureWindow = { handle: string; pid: number };

/** One private child pipe; native code has only read-only window metadata APIs. */
export class WindowTracker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private watchdog: NodeJS.Timeout | undefined;
  private lastAlive = Date.now();
  private closing = false;
  private paused = false;
  private fixtureTests = false;
  private foregroundFixture: FixtureWindow | null = null;
  private exitPromise: Promise<void> = Promise.resolve();
  ready = false;
  stats: { cpuMs: number; workingSetBytes: number; privateBytes: number; monotonicMs: number; receivedAtMs: number } | null = null;
  constructor(private readonly onEvent: (event: TrackingEvent) => void, private readonly onAvailability: (available: boolean) => void) {}
  get pid(): number | undefined { return this.child?.pid; }
  start(executable: string, fixtureTests = false, overlayHandle?: string): void {
    this.fixtureTests = fixtureTests;
    const child = spawn(executable, [String(process.pid), ...(fixtureTests ? ['--fixture-tests'] : []), ...(overlayHandle ? ['--overlay', overlayHandle] : [])], { windowsHide: true, stdio: 'pipe' });
    this.child = child;
    this.exitPromise = new Promise(resolve => child.once('close', () => { this.fail(); resolve(); }));
    child.on('error', () => this.fail());
    child.stdin.on('error', () => this.fail());
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      this.buffer += data;
      if (this.buffer.length > 8192) { this.fail(); return; }
      let boundary: number;
      while ((boundary = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'ready' && !this.ready && !this.closing) { this.ready = true; this.lastAlive = Date.now(); this.onAvailability(true); }
          else if (value.type === 'alive' && this.ready && Number.isFinite(value.cpuMs) && value.cpuMs >= 0 && Number.isSafeInteger(value.workingSetBytes) && value.workingSetBytes >= 0
            && Number.isSafeInteger(value.privateBytes) && value.privateBytes >= 0 && Number.isFinite(value.monotonicMs) && value.monotonicMs >= 0) {
            this.lastAlive = Date.now(); this.stats = { cpuMs: value.cpuMs, workingSetBytes: value.workingSetBytes, privateBytes: value.privateBytes, monotonicMs: value.monotonicMs, receivedAtMs: performance.now() };
          } else if (this.ready && !this.closing) this.onEvent(parseWindowEvent(value) as TrackingEvent);
        } catch { this.fail(); return; }
      }
    });
    child.stderr.resume(); // Never expose process paths/errors as product UI text.
    this.watchdog = setInterval(() => { if (!this.paused && Date.now() - this.lastAlive > 5000) this.fail(); }, 1000);
  }
  select(id: number, fixture?: FixtureWindow): void {
    if (!this.ready || this.closing || this.paused || !Number.isInteger(id) || id < 1 || id > 2147483647) throw new Error('Window tracker unavailable');
    const target = fixture ?? this.foregroundFixture;
    if (target) {
      this.validateFixture(target);
      this.child?.stdin.write(`${fixture ? 'test-select' : 'test-foreground'} ${id} ${target.handle} ${target.pid}\n`); return;
    }
    this.child?.stdin.write(`select ${id}\n`);
  }
  setForegroundFixture(fixture: FixtureWindow): void {
    this.validateFixture(fixture);
    this.foregroundFixture = { ...fixture };
  }
  pick(id: number, fixture?: FixtureWindow): void {
    if (!this.ready || this.closing || this.paused || !Number.isInteger(id) || id < 1 || id > 2147483647) throw new Error('Window tracker unavailable');
    const target = fixture ?? this.foregroundFixture;
    if (target) {
      this.validateFixture(target);
      this.child?.stdin.write(`test-pick ${id} ${target.handle} ${target.pid}\n`);
    } else this.child?.stdin.write(`pick ${id}\n`);
  }
  private validateFixture(fixture: FixtureWindow): void {
    if (!this.fixtureTests || !/^[1-9][0-9]{0,18}$/.test(fixture.handle) || !Number.isInteger(fixture.pid) || fixture.pid <= 0 || fixture.pid > 4294967295) throw new Error('Invalid fixture');
  }
  stop(): void { if (this.ready && !this.closing) this.child?.stdin.write('stop\n'); }
  setPaused(next: boolean): void {
    if (next) this.stop();
    this.paused = next;
    // Sleep is not a helper failure. Allow a fresh heartbeat after resuming.
    this.lastAlive = Date.now();
  }
  private fail(): void {
    const wasReady = this.ready; this.ready = false;
    clearInterval(this.watchdog);
    if (!this.closing) { this.closing = true; this.child?.kill(); this.onAvailability(false); }
    else if (wasReady) this.onAvailability(false);
  }
  async close(): Promise<void> {
    this.closing = true; this.ready = false; clearInterval(this.watchdog);
    this.child?.stdin.end('quit\n');
    const timeout = setTimeout(() => this.child?.kill(), 1000);
    await this.exitPromise;
    clearTimeout(timeout);
  }
}
