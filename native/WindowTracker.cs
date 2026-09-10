// Read-only metadata for ONE explicitly selected top-level window. No screen,
// titles, text, input hooks, window manipulation or network APIs are used.
// Stack inspection compares the selected window's immediate predecessor with
// our own overlay. No neighbouring window's content, title or bounds is read.
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class WindowTracker {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    delegate void WinEvent(IntPtr hook, uint ev, IntPtr window, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int GetFrame(IntPtr window, uint attribute, out Rect rect, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int GetCloaked(IntPtr window, uint attribute, out int value, int size);
    static Control dispatcher;
    static Process parent;
    static IntPtr selected, destroyHook;
    static IntPtr overlay;
    static int orderVersion;
    static uint selectedPid, selectedThread;
    static int request;
    static bool testMode;
    static string lastState = "";
    static System.Windows.Forms.Timer poll;
    // Root this delegate for the entire native hook lifetime.
    static readonly WinEvent destroyed = OnDestroyed;

    static void Emit(string value) { Console.Out.WriteLine(value); Console.Out.Flush(); }
    static void Stop() {
        poll.Stop();
        if (destroyHook != IntPtr.Zero) UnhookWinEvent(destroyHook);
        destroyHook = selected = IntPtr.Zero;
        request = 0; lastState = ""; orderVersion = 0;
    }
    static void End(string reason) {
        int id = request; Stop();
        Emit("{\"type\":\"end\",\"id\":" + id + ",\"reason\":\"" + reason + "\"}");
    }
    static void OnDestroyed(IntPtr hook, uint ev, IntPtr window, int obj, int child, uint thread, uint time) {
        if (window == selected && obj == 0 && child == 0 && request != 0) End("closed");
    }
    static void Select(int id, IntPtr knownWindow, uint expectedPid) {
        Stop(); request = id;
        selected = GetAncestor(knownWindow == IntPtr.Zero ? GetForegroundWindow() : knownWindow, 2); // GA_ROOT, never a child control.
        selectedThread = GetWindowThreadProcessId(selected, out selectedPid);
        if (expectedPid != 0 && selectedPid != expectedPid) { End("ineligible"); return; }
        var name = new StringBuilder(128);
        GetClassName(selected, name, name.Capacity);
        string className = name.ToString();
        if (selected == IntPtr.Zero || selectedPid == 0 || selectedPid == parent.Id || selectedPid == Process.GetCurrentProcess().Id
            || className == "Progman" || className == "WorkerW" || className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd") {
            End("ineligible"); return;
        }
        // Only this process/thread's window-destruction events; no input hooks.
        destroyHook = SetWinEventHook(0x8001, 0x8001, IntPtr.Zero, destroyed, selectedPid, selectedThread, 0);
        if (destroyHook == IntPtr.Zero) { End("unavailable"); return; }
        Poll();
        if (request != 0) poll.Start();
    }
    static void Poll() {
        if (request == 0) return;
        uint pid; uint thread = GetWindowThreadProcessId(selected, out pid);
        if (!IsWindow(selected) || pid != selectedPid || thread != selectedThread) { End("closed"); return; }
        string state = "visible";
        int cloaked;
        if (IsIconic(selected)) state = "minimized";
        else if (!IsWindowVisible(selected) || (GetCloaked(selected, 14, out cloaked, 4) == 0 && cloaked != 0)) state = "hidden";
        Rect rect = new Rect();
        if (state == "visible" && GetFrame(selected, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0) { End("unavailable"); return; }
        long width = (long)rect.Right - rect.Left, height = (long)rect.Bottom - rect.Top;
        if (state == "visible" && (width <= 0 || height <= 0 || width > 1000000 || height > 1000000)) { End("unavailable"); return; }
        bool topmost = (GetWindowLongPtr(selected, -20).ToInt64() & 8) != 0; // WS_EX_TOPMOST
        bool adjacent = overlay != IntPtr.Zero && GetWindow(selected, 3) == overlay; // GW_HWNDPREV
        // A hidden overlay (for example, no headroom) needs no order retries.
        if (state == "visible" && IsWindowVisible(overlay) && !adjacent) orderVersion++;
        string value = "{\"type\":\"window\",\"id\":" + request + ",\"state\":\"" + state
            + "\",\"x\":" + rect.Left + ",\"y\":" + rect.Top + ",\"width\":" + width + ",\"height\":" + height
            + ",\"sourceId\":\"window:" + selected.ToInt64() + ":0\",\"topmost\":" + (topmost ? "true" : "false")
            + ",\"adjacent\":" + (adjacent ? "true" : "false") + ",\"orderVersion\":" + orderVersion + "}";
        if (value != lastState) { lastState = value; Emit(value); }
    }
    static void Command(string line) {
        if (line == "quit") { Application.ExitThread(); return; }
        if (line == "stop") { Stop(); return; }
        int id;
        if (line.StartsWith("select ", StringComparison.Ordinal) && int.TryParse(line.Substring(7), out id) && id > 0) { Select(id, IntPtr.Zero, 0); return; }
        // Only isolated acceptance builds use a known fixture HWND/PID. This
        // prevents foreground races from inspecting any unrelated user window.
        var parts = line.Split(' '); long handle; uint pid;
        if (testMode && parts.Length == 4 && parts[0] == "test-select" && int.TryParse(parts[1], out id) && id > 0
            && long.TryParse(parts[2], out handle) && handle > 0 && uint.TryParse(parts[3], out pid) && pid > 0) {
            Select(id, new IntPtr(handle), pid); return;
        }
        Application.ExitThread(); // This pipe accepts only three bounded commands.
    }
    [STAThread] static int Main(string[] args) {
        try {
            int parentId;
            if (args.Length < 1 || !int.TryParse(args[0], out parentId) || parentId <= 0) return 2;
            for (int i = 1; i < args.Length; i++) {
                if (args[i] == "--fixture-tests" && !testMode) testMode = true;
                else if (args[i] == "--overlay" && overlay == IntPtr.Zero && i + 1 < args.Length) {
                    long handle; uint owner;
                    if (!long.TryParse(args[++i], out handle) || handle <= 0) return 2;
                    overlay = new IntPtr(handle);
                    GetWindowThreadProcessId(overlay, out owner);
                    if (owner != parentId || GetAncestor(overlay, 2) != overlay) return 2;
                } else return 2;
            }
            parent = Process.GetProcessById(parentId);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            // Retain an OS handle so parent PID reuse cannot keep this helper alive.
            IntPtr parentHandle = parent.Handle;
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
            dispatcher = new Control(); IntPtr receiver = dispatcher.Handle;
            poll = new System.Windows.Forms.Timer(); poll.Interval = 50;
            poll.Tick += delegate { Poll(); };
            var lifetime = new System.Windows.Forms.Timer(); lifetime.Interval = 1000;
            lifetime.Tick += delegate {
                if (parent.HasExited) { Application.ExitThread(); return; }
                using (var self = Process.GetCurrentProcess()) {
                    Emit("{\"type\":\"alive\",\"cpuMs\":" + self.TotalProcessorTime.TotalMilliseconds.ToString("F3", CultureInfo.InvariantCulture)
                        + ",\"workingSetBytes\":" + self.WorkingSet64
                        + ",\"privateBytes\":" + self.PrivateMemorySize64
                        + ",\"monotonicMs\":" + (Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency).ToString("F3", CultureInfo.InvariantCulture) + "}");
                }
            };
            lifetime.Start();
            var input = new Thread(delegate() {
                try {
                    while (true) {
                        var command = new StringBuilder(); int value;
                        while ((value = Console.In.Read()) != -1 && value != '\n') {
                            if (command.Length >= 64) { dispatcher.BeginInvoke((Action)Application.ExitThread); return; }
                            if (value != '\r') command.Append((char)value);
                        }
                        if (value == -1) { dispatcher.BeginInvoke((Action)Application.ExitThread); return; }
                        string line = command.ToString();
                        dispatcher.BeginInvoke((Action)(() => Command(line)));
                    }
                } catch { try { dispatcher.BeginInvoke((Action)Application.ExitThread); } catch { } }
            });
            input.IsBackground = true; input.Start();
            Emit("{\"type\":\"ready\"}");
            Application.Run();
            Stop(); lifetime.Dispose(); poll.Dispose(); dispatcher.Dispose(); parent.Dispose();
            return 0;
        } catch { return 1; }
    }
}
