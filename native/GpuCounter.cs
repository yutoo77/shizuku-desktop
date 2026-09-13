// Explicit measurement helper only; never launched by the companion.
// No console, windows, input, network, system settings or process termination
// APIs. PDH values are filtered to recorded, still-identical target processes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

internal static class GpuCounter {
    [StructLayout(LayoutKind.Sequential)] struct Value { public uint Status; public double Number; }
    [StructLayout(LayoutKind.Sequential)] struct Item { public IntPtr Name; public Value Value; }
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string source, UIntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string name, UIntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] static extern uint PdhCollectQueryDataWithTime(IntPtr query, out long time);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);
    [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr query);
    const uint MoreData = 0x800007D2, Format = 0x00008200; // DOUBLE | NOCAP100
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static string directory;
    static void Stage(string stage, uint code) {
        try { File.AppendAllText(Path.Combine(directory, "stages.jsonl"), Json.Serialize(new { stage, code, time = DateTime.UtcNow.ToString("o") }) + "\n"); }
        catch { /* Missing stage evidence makes the driver report failure. */ }
    }
    static long Started(int pid) {
        using (Process process = Process.GetProcessById(pid)) {
            if (process.HasExited) throw new InvalidOperationException();
            return process.StartTime.ToUniversalTime().Ticks;
        }
    }
    static object Read(IntPtr counter, long nativeTime, DateTime completed, DateTime previousStarted, Dictionary<int, long> targets) {
        string reason = null;
        foreach (var target in targets) {
            try { if (Started(target.Key) != target.Value) reason = "target-process-changed"; }
            catch { reason = "target-process-unavailable"; }
        }
        uint size = 0, count;
        uint code = PdhGetFormattedCounterArrayW(counter, Format, ref size, out count, IntPtr.Zero);
        var engines = new Dictionary<string, double>();
        int invalid = 0;
        if (reason == null && code == MoreData && size > 0 && size <= 16 * 1024 * 1024) {
            IntPtr buffer = Marshal.AllocHGlobal((int)size);
            try {
                uint allocated = size;
                code = PdhGetFormattedCounterArrayW(counter, Format, ref size, out count, buffer);
                int stride = Marshal.SizeOf(typeof(Item));
                if (code != 0 || (long)count * stride > allocated) reason = "counter-read-failed";
                else for (int i = 0; i < count; i++) {
                    Item item = (Item)Marshal.PtrToStructure(IntPtr.Add(buffer, i * stride), typeof(Item));
                    string name = Marshal.PtrToStringUni(item.Name);
                    if (name == null || !name.StartsWith("pid_", StringComparison.OrdinalIgnoreCase)) continue;
                    int end = name.IndexOf('_', 4), pid;
                    if (end < 0 || !Int32.TryParse(name.Substring(4, end - 4), out pid) || !targets.ContainsKey(pid)) continue;
                    double value = item.Value.Number;
                    if (item.Value.Status > 1 || Double.IsNaN(value) || Double.IsInfinity(value) || value < 0 || value > 100) { invalid++; continue; }
                    string engine = name.Substring(end + 1);
                    double current; engines.TryGetValue(engine, out current); engines[engine] = current + value;
                }
            } finally { Marshal.FreeHGlobal(buffer); }
        } else if (reason == null) reason = "counter-buffer-unavailable";
        double busiest = 0;
        foreach (double value in engines.Values) busiest = Math.Max(busiest, value);
        if (reason == null && engines.Count == 0) reason = "no-target-counters";
        if (reason == null && (invalid > 0 || busiest > 100)) reason = "invalid-counter-value";
        // Retain PDH's timestamp verbatim. In the local comparison it was nine
        // hours ahead of UTC. Bound each interval with observed UTC call times
        // instead of guessing the native timestamp's time-zone convention.
        return new { time = completed.ToString("o"), intervalStart = previousStarted.ToString("o"), nativeTimestamp = nativeTime.ToString(),
            available = reason == null, reason, counterStatus = code, invalidCounters = invalid,
            busiestEnginePercent = reason == null ? (double?)busiest : null, engines };
    }
    static int Main(string[] args) {
        IntPtr query = IntPtr.Zero;
        try {
            if (args.Length != 1) return 2;
            string request = Path.GetFullPath(args[0]); directory = Path.GetDirectoryName(request);
            var input = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(request));
            int samples = Convert.ToInt32(input["samples"]), parentPid = Convert.ToInt32(input["parentPid"]);
            if (samples < 2 || samples > 1800) return 2;
            var ids = (System.Collections.ArrayList)input["pids"];
            if (ids.Count < 1 || ids.Count > 2048) return 2;
            // A killed driver cannot leave this measurement helper behind.
            Process parent = Process.GetProcessById(parentPid);
            var parentWatch = new Thread(() => { try { parent.WaitForExit(); } catch { } Environment.Exit(3); }); parentWatch.IsBackground = true; parentWatch.Start();
            var deadline = new Thread(() => { Thread.Sleep(samples * 2000 + 10000); Environment.Exit(4); }); deadline.IsBackground = true; deadline.Start();
            var targets = new Dictionary<int, long>();
            foreach (object id in ids) { int pid = Convert.ToInt32(id); if (pid <= 0) return 2; targets[pid] = Started(pid); }
            Stage("open", 0);
            uint code = PdhOpenQueryW(null, UIntPtr.Zero, out query); if (code != 0) { Stage("open-failed", code); return 1; }
            Stage("add", 0);
            IntPtr counter;
            code = PdhAddEnglishCounterW(query, @"\GPU Engine(*)\Utilization Percentage", UIntPtr.Zero, out counter);
            if (code != 0) { Stage("add-failed", code); return 1; }
            Stage("prime", 0);
            long previous;
            DateTime previousStarted = DateTime.UtcNow;
            code = PdhCollectQueryDataWithTime(query, out previous); if (code != 0) { Stage("prime-failed", code); return 1; }
            Stage("sampling", 0);
            var watch = Stopwatch.StartNew();
            using (var output = new StreamWriter(Path.Combine(directory, "samples.jsonl"), false)) {
                output.AutoFlush = true;
                for (int i = 0; i < samples; i++) {
                    long next = (i + 1) * 2000;
                    while (watch.ElapsedMilliseconds < next) {
                        if (File.Exists(Path.Combine(directory, "stop"))) { Stage("cancelled", 0); return 3; }
                        Thread.Sleep((int)Math.Max(1, Math.Min(50, next - watch.ElapsedMilliseconds)));
                    }
                    DateTime started = DateTime.UtcNow;
                    long time; code = PdhCollectQueryDataWithTime(query, out time);
                    DateTime completed = DateTime.UtcNow;
                    if (code != 0) { Stage("collect-failed", code); return 1; }
                    output.WriteLine(Json.Serialize(Read(counter, time, completed, previousStarted, targets))); previousStarted = started;
                }
            }
            Stage("complete", 0); return 0;
        } catch { if (directory != null) Stage("failed", 0); return 1; }
        finally { if (query != IntPtr.Zero) { uint code = PdhCloseQuery(query); Stage("closed", code); } }
    }
}
