const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identity = process => `${process.pid}:${process.creationTime}`;

function stats(values, mean = undefined) {
  if (!values.length || !values.every(nonnegative)) throw new Error('Cannot summarize missing or invalid measurements.');
  return { mean: mean ?? values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values), max: Math.max(...values), samples: values.length };
}

/**
 * Stable-phase measurements only. Cumulative CPU seconds are independent of the
 * interval reset by percentCPUUsage; missing values fail instead of becoming 0.
 * https://www.electronjs.org/docs/latest/api/structures/cpu-usage
 * https://www.electronjs.org/docs/latest/api/structures/memory-info
 */
export function summarizeSoakPhase(samples, { logicalProcessors, visible, scale = 100, maxGapMs = 10_000 }) {
  if (!Number.isSafeInteger(logicalProcessors) || logicalProcessors < 1) throw new TypeError('A positive logical processor count is required.');
  if (typeof visible !== 'boolean' || ![80, 100, 120].includes(scale) || !nonnegative(maxGapMs) || maxGapMs === 0) {
    throw new TypeError('A fixed visibility, supported size, and positive maximum sample gap are required.');
  }
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('A phase requires at least two samples.');

  let expectedIdentities;
  let expectedReducedMotion;
  let expectedQuiet;
  let totalCpuSeconds = 0;
  let elapsedSeconds = 0;
  const cpuPercent = [], workingSet = [], privateBytes = [], fps = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const diagnostics = sample?.diagnostics;
    if (!sample || !nonnegative(sample.monotonicMs) || !Number.isFinite(Date.parse(sample.time))
      || sample.visible !== visible || sample.loaded !== true || sample.scale !== scale
      || !diagnostics || diagnostics.loaded !== true || diagnostics.visible !== visible
      || diagnostics.moving !== false || diagnostics.reacting !== false
      || typeof diagnostics.reducedMotion !== 'boolean' || !nonnegative(diagnostics.fps)
      || !Number.isSafeInteger(diagnostics.renderedFrames) || diagnostics.renderedFrames < 0) {
      throw new Error(`Invalid or changing phase state at sample ${index}.`);
    }
    if (index === 0) { expectedReducedMotion = diagnostics.reducedMotion; expectedQuiet = diagnostics.quiet === true; }
    if (diagnostics.reducedMotion !== expectedReducedMotion) throw new Error('Reduced-motion preference changed inside the phase.');
    if ((diagnostics.quiet === true) !== expectedQuiet) throw new Error('Quiet preference changed inside the phase.');
    if (!Array.isArray(sample.processes) || !sample.processes.length
      || !sample.processes.every(process => process && Number.isSafeInteger(process.pid) && process.pid > 0
        && nonnegative(process.creationTime) && nonnegative(process.cpu?.cumulativeCPUUsage)
        && nonnegative(process.memory?.workingSetSize) && nonnegative(process.memory?.privateBytes))) {
      throw new Error(`Missing or invalid process metrics at sample ${index}.`);
    }
    const processIdentities = sample.processes.map(identity).sort();
    if (new Set(processIdentities).size !== processIdentities.length) throw new Error('Duplicate process identities.');
    const ids = processIdentities.join('|');
    if (index === 0) expectedIdentities = ids;
    if (ids !== expectedIdentities) throw new Error('App processes changed inside the phase; repeat a stable period.');

    workingSet.push(sample.processes.reduce((sum, process) => sum + process.memory.workingSetSize, 0) / 1024);
    privateBytes.push(sample.processes.reduce((sum, process) => sum + process.memory.privateBytes, 0) / 1024);
    fps.push(diagnostics.fps);
    if (index === 0) continue;
    const previous = samples[index - 1];
    const dtMs = sample.monotonicMs - previous.monotonicMs;
    if (dtMs <= 0 || dtMs > maxGapMs || Date.parse(sample.time) <= Date.parse(previous.time)) {
      throw new Error('Non-increasing timestamps or a long measurement gap; do not bridge the interval.');
    }
    const frameDelta = diagnostics.renderedFrames - previous.diagnostics.renderedFrames;
    if (frameDelta < 0 || ((!visible || expectedReducedMotion || expectedQuiet) && frameDelta !== 0)
      || (visible && !expectedReducedMotion && !expectedQuiet && frameDelta === 0)) {
      throw new Error('Rendering stopped, restarted, or continued in an idle phase unexpectedly.');
    }
    let cpuSeconds = 0;
    for (const process of sample.processes) {
      const prior = previous.processes.find(value => identity(value) === identity(process));
      const delta = process.cpu.cumulativeCPUUsage - prior.cpu.cumulativeCPUUsage;
      if (!nonnegative(delta)) throw new Error('Cumulative CPU usage decreased or became invalid.');
      cpuSeconds += delta;
    }
    const elapsed = dtMs / 1000;
    const percent = cpuSeconds / elapsed / logicalProcessors * 100;
    if (!nonnegative(percent) || percent > 100.5) throw new Error('CPU interval exceeds the declared processor capacity.');
    cpuPercent.push(percent);
    totalCpuSeconds += cpuSeconds;
    elapsedSeconds += elapsed;
  }
  const first = samples[0], last = samples.at(-1);
  return {
    start: first.time, end: last.time, durationSeconds: elapsedSeconds,
    visible, scale, reducedMotion: expectedReducedMotion, quiet: expectedQuiet,
    processIdentities: expectedIdentities, processCount: first.processes.length,
    cpuDurationSeconds: elapsedSeconds, totalCpuSeconds,
    cpuPercentOfPC: stats(cpuPercent, totalCpuSeconds / elapsedSeconds / logicalProcessors * 100),
    workingSetMiB: { ...stats(workingSet), first: workingSet[0], last: workingSet.at(-1), change: workingSet.at(-1) - workingSet[0] },
    privateMiB: { ...stats(privateBytes), first: privateBytes[0], last: privateBytes.at(-1), change: privateBytes.at(-1) - privateBytes[0] },
    reportedFps: stats(fps),
    observedFps: (last.diagnostics.renderedFrames - first.diagnostics.renderedFrames) / elapsedSeconds,
    renderedFrames: { first: first.diagnostics.renderedFrames, last: last.diagnostics.renderedFrames },
    samples: samples.length,
  };
}

/** Helper samples arrive once per second. Keep their time base separate, and
 * disclose the endpoint skew instead of treating stale/missing reports as zero. */
export function summarizeCompanionPhase(samples, options) {
  const electron = summarizeSoakPhase(samples, options);
  const sets = [], privates = [];
  const pid = samples[0]?.windowTracker?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Missing helper identity.');
  for (const [i, sample] of samples.entries()) {
    const helper = sample.windowTracker, s = helper?.stats;
    if (helper?.pid !== pid || helper.ready !== true || !s
      || !['cpuMs', 'workingSetBytes', 'privateBytes', 'monotonicMs', 'receivedAtMs'].every(key => nonnegative(s[key]))
      || sample.monotonicMs < s.receivedAtMs || sample.monotonicMs - s.receivedAtMs > 2500) throw new Error('Missing, stale or changed helper metrics.');
    if (i && (s.monotonicMs <= samples[i - 1].windowTracker.stats.monotonicMs || s.cpuMs < samples[i - 1].windowTracker.stats.cpuMs)) throw new Error('Helper clock or CPU reset.');
    sets.push(s.workingSetBytes / 1048576);
    privates.push(s.privateBytes / 1048576);
  }
  const first = samples[0].windowTracker.stats, last = samples.at(-1).windowTracker.stats;
  const durationSeconds = (last.monotonicMs - first.monotonicMs) / 1000;
  const endpointSkewSeconds = durationSeconds - electron.durationSeconds;
  if (durationSeconds <= 0 || Math.abs(endpointSkewSeconds) > 2.5) throw new Error('Helper interval does not cover the phase.');
  const cpuPercentOfPC = (last.cpuMs - first.cpuMs) / 1000 / durationSeconds / options.logicalProcessors * 100;
  if (cpuPercentOfPC > 100.5) throw new Error('Helper CPU exceeds capacity.');
  const totalSet = sets.map((n, i) => n + samples[i].processes.reduce((sum, p) => sum + p.memory.workingSetSize, 0) / 1024);
  const totalPrivate = privates.map((n, i) => n + samples[i].processes.reduce((sum, p) => sum + p.memory.privateBytes, 0) / 1024);
  return { electron, helper: { pid, durationSeconds, endpointSkewSeconds, cpuPercentOfPC, workingSetMiB: stats(sets), privateMiB: stats(privates) },
    total: { approximateCpuPercentOfPC: electron.cpuPercentOfPC.mean + cpuPercentOfPC, workingSetMiB: stats(totalSet), privateMiB: stats(totalPrivate) } };
}
