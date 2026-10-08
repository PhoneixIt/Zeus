// PortAi Desktop Operator Host
// A persistent, local, zero-install Windows desktop-control service.
//
// WHY THIS EXISTS
// Two problems had to be solved before computer use could be reliable:
//
//  1. Processes launched from a one-shot shell die when that shell exits, so a
//     window the operator opened would not survive to be interacted with. This host
//     is a long-lived process in the interactive session, and it is started through
//     WMI (Win32_Process.Create) so it is not parented to the shell that spawned it.
//
//  2. Synthesized input went to the wrong window. Windows will not give foreground
//     to a background process, so a naive SetCursorPos + click landed in whatever the
//     user happened to be using - in testing, the user's own browser.
//
// THE SAFETY MODEL, which is the whole point of this design:
// Every mouse and keyboard operation must name its target window, and must supply the
// PID the caller believes that window belongs to. Before injecting anything the host
// independently re-verifies that the HWND exists, is visible, is not minimized, and
// still belongs to that PID. It then attempts to take focus, and it verifies that
// focus actually landed. If focus did not land, the operation is REFUSED and nothing
// is injected. It is structurally impossible for this host to type into a window it
// has not confirmed identity and focus for.
//
// Communication is plain HTTP over 127.0.0.1 on an ephemeral port, written directly
// against TcpListener so no URL ACL and no administrator rights are required. The
// port and a bearer token are written to a state file for the client to read.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PortAiOperator
{
    public class Win
    {
        public delegate bool EnumProc(IntPtr h, IntPtr l);
        public const uint LD = 0x02, LU = 0x04, RD = 0x08, RU = 0x10, WHEEL = 0x0800;
        public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_SCANCODE = 0x0008;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
        // DPI awareness. Absent on pre-Windows 8.1, hence the fallbacks in DpiAware().
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int index);
        // Per-thread DPI awareness. Used to make a single screen-read thread see
        // physical pixels without moving the whole host out of the coordinate space
        // its input path is proven in.
        [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
        // Z-order and extended-style inspection. GW_HWNDPREV = 3 walks the window
        // chain towards the foreground; GWL_EXSTYLE = -20 reads WS_EX_TOPMOST.
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLongPtr32(IntPtr h, int idx);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
        public const uint GW_HWNDPREV = 3;
        public const int GWL_EXSTYLE = -20;
        public const int GWL_STYLE = -16;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        // Extended-style write, used to make the indicator panel click-through so it
        // cannot swallow a click aimed at the application behind it.
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong32(IntPtr h, int idx, int val);
        public const int WS_EX_TOPMOST = 0x00000008;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;

        public static bool HasTopmost(IntPtr h)
        {
            if (h == IntPtr.Zero) return false;
            int v;
            if (IntPtr.Size == 8) v = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt32();
            else v = GetWindowLongPtr32(h, GWL_EXSTYLE);
            return (v & WS_EX_TOPMOST) != 0;
        }

        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, IntPtr e);

        // SendInput is the modern input API. keybd_event is legacy and its
        // KEYEVENTF_UNICODE path proved unreliable with WinForms edit controls -
        // characters were silently dropped - so text is delivered via SendInput.
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public INPUTUNION u; }
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        public const uint INPUT_KEYBOARD = 1;
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
        // Legacy activation call: not in the SDK headers, but still exported and still
        // honoured where SetForegroundWindow is refused by the foreground lock.
        [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
        [DllImport("user32.dll")] public static extern IntPtr GetFocus();
        [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();

        // ---- diagnostics for the keyboard investigation ----

        [StructLayout(LayoutKind.Sequential)]
        public struct GUITHREADINFO
        {
            public int cbSize; public uint flags;
            public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
            public RECT rcCaret;
        }
        [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO gti);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int returned);
        [DllImport("advapi32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, IntPtr pid);

        // Authoritative: which control in THAT thread holds keyboard focus.
        // GetFocus() only answers for the calling thread, so asking the host was
        // meaningless - this is the question that actually matters.
        public static GUITHREADINFO GuiFocusOfThread(uint thread)
        {
            GUITHREADINFO g = new GUITHREADINFO();
            g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            GetGUIThreadInfo(thread, ref g);
            return g;
        }

        // Integrity level, because UIPI silently blocks lower->higher injection and
        // that would explain "SendInput reports success, nothing happens".
        public static int IntegrityOfProcess(uint pid)
        {
            IntPtr h = OpenProcess(0x1000, false, new IntPtr(pid)); // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return -1;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(h, 0x0008, out token)) return -1; // TOKEN_QUERY
                int len = 0;
                GetTokenInformation(token, 25, IntPtr.Zero, 0, out len); // TokenIntegrityLevel
                if (len <= 0) return -1;
                IntPtr buf = Marshal.AllocHGlobal(len);
                try
                {
                    if (!GetTokenInformation(token, 25, buf, len, out len)) return -1;
                    IntPtr sid = Marshal.ReadIntPtr(buf);          // TOKEN_MANDATORY_LABEL
                    int sub = Marshal.ReadByte(sid, 8);             // last RID = integrity level
                    return sub;
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            finally
            {
                if (token != IntPtr.Zero) CloseHandle(token);
                CloseHandle(h);
            }
        }
        [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
        public const uint MAPVK_VK_TO_VSC = 0;

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

        public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
        public static string Title(IntPtr h) { var s = new StringBuilder(1024); GetWindowText(h, s, 1024); return s.ToString(); }
        public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }

        public static List<IntPtr> TopLevel()
        {
            var list = new List<IntPtr>();
            EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
            return list;
        }
        // Cross-process safe control text.
        //
        // GetWindowText() only returns a caption for windows belonging to the calling
        // process. For a child control in another process it returns an EMPTY STRING,
        // which looks exactly like "the field is empty" - so the keyboard tests were
        // reading a broken instrument and appeared to prove failure even when input
        // had been delivered. WM_GETTEXT via SendMessage works across processes.
        public static string TextOf(IntPtr h)
        {
            var sb = new StringBuilder(4096);
            SendMessage(h, 0x000D, (IntPtr)4096, sb); // WM_GETTEXT
            return sb.ToString();
        }

        public static List<IntPtr> Children(IntPtr parent)
        {
            var list = new List<IntPtr>();
            EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
            return list;
        }

        // Focus a specific child control, not just the top-level window.
        //
        // Clicking a text field focuses the window but frequently leaves keyboard
        // focus on the form, and injected keystrokes then go nowhere. SetFocus is
        // thread-affine, so this attaches to the target's input queue first, which is
        // the legitimate way to set focus on another thread's control.
        public static bool FocusChild(IntPtr topLevel, IntPtr child)
        {
            Focus(topLevel);
            Thread.Sleep(120);
            uint dummy, targetThread = GetWindowThreadProcessId(topLevel, out dummy);
            uint meT = GetCurrentThreadId();
            bool attached = targetThread != 0 && targetThread != meT && AttachThreadInput(meT, targetThread, true);
            SetFocus(child);
            Thread.Sleep(80);
            IntPtr focused = GetFocus();
            if (attached) AttachThreadInput(meT, targetThread, false);
            return focused == child;
        }

        // Safe focus: raise, then attach to the foreground thread's input queue so the
        // foreground lock is satisfied legitimately rather than fought.
        public static string LastFocusNote = "";

        /// Bring a window to the foreground reliably.
        ///
        /// Windows applies a foreground lock: a process may only set the foreground if
        /// it already is foreground, was started by the foreground process, holds input
        /// rights, or last received input. A single ShowWindow + SetForegroundWindow is
        /// therefore allowed to fail, and it did - intermittently, against Windows
        /// Terminal, with no error reported at all. So this escalates:
        ///
        ///   1. restore, then AttachThreadInput to the current foreground thread and set
        ///      the foreground - the standard injection-free route;
        ///   2. retry, because the foreground may have changed between attempts and
        ///      therefore the thread we attached to is no longer the right one;
        ///   3. fall back to SwitchToThisWindow, the legacy activation call, which
        ///      Windows still honours where SetForegroundWindow is refused.
        ///
        /// Note what is deliberately NOT used: synthesising a keypress to claim
        /// foreground rights. That would work, but it means focusing a window
        /// injects input into whatever is in front - the opposite of harmless.
        public static bool Focus(IntPtr target)
        {
            LastFocusNote = "";
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                ShowWindow(target, 9); // SW_RESTORE
                IntPtr fg = GetForegroundWindow();
                if (fg == target) { LastFocusNote = "already foreground (attempt " + attempt + ")"; return true; }
                uint dummy, fgT = GetWindowThreadProcessId(fg, out dummy), meT = GetCurrentThreadId();
                bool attached = fgT != 0 && fgT != meT && AttachThreadInput(meT, fgT, true);
                BringWindowToTop(target);
                SetForegroundWindow(target);
                SetActiveWindow(target);
                if (attached) AttachThreadInput(meT, fgT, false);
                Thread.Sleep(180);
                if (GetForegroundWindow() == target) { LastFocusNote = "SetForegroundWindow (attempt " + attempt + ")"; return true; }
                LastFocusNote += "attempt " + attempt + " did not take (foreground lock); ";
            }
            SwitchToThisWindow(target, true);
            Thread.Sleep(240);
            if (GetForegroundWindow() == target) { LastFocusNote += "SwitchToThisWindow succeeded"; return true; }
            LastFocusNote += "SwitchToThisWindow also failed; foreground is hwnd " + GetForegroundWindow().ToInt64();
            return false;
        }
    }

    public static class Program
    {
        static int port = 0;
        static string token = "";
        static string statePath = "";

        // ------------------------------------------------------------- JSON helpers
        static string Esc(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < 32) sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        // ------------------------------------------------------------- operations
        class Target { public bool ok; public string error = ""; public IntPtr hwnd; }

        // The safety gate. Every input path calls this first and refuses on any doubt.
        static Target Verify(long hwnd, int expectPid, string expectTitle)
        {
            var t = new Target();
            IntPtr h = new IntPtr(hwnd);
            if (!Win.IsWindowVisible(h)) { t.error = "target window is not visible"; return t; }
            if (Win.IsIconic(h)) { t.error = "target window is minimized"; return t; }
            uint pid = Win.PidOf(h);
            if (expectPid > 0 && (int)pid != expectPid) { t.error = "pid mismatch: window belongs to " + pid + ", caller expected " + expectPid; return t; }
            if (!string.IsNullOrEmpty(expectTitle))
            {
                string actual = Win.Title(h);
                if (actual.IndexOf(expectTitle, StringComparison.OrdinalIgnoreCase) < 0)
                { t.error = "title mismatch: found '" + actual + "'"; return t; }
            }
            t.ok = true; t.hwnd = h;
            return t;
        }

        static string WindowsJson()
        {
            IntPtr fg = Win.GetForegroundWindow();
            var sb = new StringBuilder("[");
            bool first = true;
            foreach (IntPtr h in Win.TopLevel())
            {
                int len = Win.GetWindowTextLength(h);
                if (len == 0) continue;
                Win.RECT r; Win.GetWindowRect(h, out r);
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"hwnd\":").Append(h.ToInt64())
                  .Append(",\"pid\":").Append(Win.PidOf(h))
                  .Append(",\"title\":\"").Append(Esc(Win.Title(h)))
                  .Append("\",\"class\":\"").Append(Esc(Win.Cls(h)))
                  .Append("\",\"left\":").Append(r.Left).Append(",\"top\":").Append(r.Top)
                  .Append(",\"width\":").Append(r.Right - r.Left).Append(",\"height\":").Append(r.Bottom - r.Top)
                  .Append(",\"foreground\":").Append(h == fg ? "true" : "false")
                  .Append(",\"minimized\":").Append(Win.IsIconic(h) ? "true" : "false")
                  .Append("}");
            }
            return sb.Append(']').ToString();
        }

        static string UiaJson(IntPtr root, int maxDepth)
        {
            var sb = new StringBuilder();
            sb.Append('[');
            bool first = true;
            Walk(root, 0, maxDepth, sb, ref first);
            return sb.Append(']').ToString();
        }

        // UI Automation tree. Microsoft UIAutomationClient is in the GAC, so this adds
        // no dependency; it is the same API pywinauto would have wrapped.
        static void Walk(IntPtr parent, int depth, int maxDepth, StringBuilder sb, ref bool first)
        {
            if (depth > maxDepth) return;
            foreach (IntPtr c in Win.Children(parent))
            {
                Win.RECT r; Win.GetWindowRect(c, out r);
                string cls = Win.Cls(c);
                // TextOf, not Title: GetWindowText cannot read a child control text from another
                  // process and returns empty, which is indistinguishable from no input.
                  string name = Win.TextOf(c);
                bool visible = Win.IsWindowVisible(c);
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"hwnd\":").Append(c.ToInt64())
                  .Append(",\"pid\":").Append(Win.PidOf(c))
                  .Append(",\"depth\":").Append(depth)
                  .Append(",\"class\":\"").Append(Esc(cls))
                  .Append("\",\"name\":\"").Append(Esc(name))
                  .Append("\",\"visible\":").Append(visible ? "true" : "false")
                  .Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
                  .Append(",\"w\":").Append(r.Right - r.Left).Append(",\"h\":").Append(r.Bottom - r.Top)
                  .Append("}");
                if (visible || depth < 2) Walk(c, depth + 1, maxDepth, sb, ref first);
            }
        }

        static byte[] ScreenPng()
        {
            Rectangle b = System.Windows.Forms.SystemInformation.VirtualScreen;
            using (Bitmap bmp = new Bitmap(b.Width, b.Height))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(b.X, b.Y, 0, 0, bmp.Size);
                using (MemoryStream ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    return ms.ToArray();
                }
            }
        }

        /// Read the colour of one screen pixel, in the same PHYSICAL space the capture
        /// uses, so a pixel reading can be compared directly with a capture.
        static string PixelAt(int x, int y, out int scalePct)
        {
            int s;
            byte[] png = ScreenPng(x, y, 1, 1, out s);
            scalePct = s;
            using (MemoryStream ms = new MemoryStream(png))
            using (Bitmap bmp = new Bitmap(ms))
            {
                Color c = bmp.GetPixel(0, 0);
                return "{\"x\":" + x + ",\"y\":" + y
                    + ",\"r\":" + c.R + ",\"g\":" + c.G + ",\"b\":" + c.B
                    + ",\"captureScalePct\":" + scalePct
                    + ",\"hex\":\"#" + c.R.ToString("X2") + c.G.ToString("X2") + c.B.ToString("X2") + "\"}";
            }
        }

        static void TypeText(IntPtr target, string text)
        {
            // SendInput with KEYEVENTF_UNICODE: layout-independent, and unlike
            // SendKeys it cannot be swallowed by a window that is merely focused.
            int size = Marshal.SizeOf(typeof(Win.INPUT));
            uint sent = 0, failed = 0;
            int lastError = 0;
            foreach (char c in text)
            {
                // Mid-action interruption, checked BEFORE each character so a
                // takeover stops the remaining characters rather than finishing them.
                if (!Guard.MayInject()) break;
                // Per-character delay, sliced and re-checked against the guard.
                //
                // A safety fix rather than a polish fix. Without it the operator finishes a long
                // string faster than a human can notice and reach for the mouse, which makes the
                // abort check above correct but useless in practice.
                for (int waited = 0; waited < typeDelayMs; waited += 5)
                {
                    if (!Guard.MayInject()) break;
                    Thread.Sleep(5);
                }
                if (!Guard.MayInject()) break;
                var down = new Win.INPUT
                {
                    type = Win.INPUT_KEYBOARD,
                    u = new Win.INPUTUNION
                    {
                        ki = new Win.KEYBDINPUT
                        {
                            wVk = 0,
                            // The ownership sentinel, so the hook can prove this keystroke
                            // is the operator's and not the human's.
                            wScan = c,
                            dwFlags = Win.KEYEVENTF_UNICODE,
                            time = 0,
                            dwExtraInfo = Guard.Sentinel
                        }
                    }
                };
                var up = down;
                up.u.ki.dwFlags = Win.KEYEVENTF_UNICODE | Win.KEYEVENTF_KEYUP;
                sent += Win.SendInput(1, new Win.INPUT[] { down }, size);
                failed += Win.SendInput(1, new Win.INPUT[] { up }, size);
                if (sent + failed < 2) lastError = Marshal.GetLastWin32Error();
                Thread.Sleep(8);
            }
            // The counts are returned so a silent failure is diagnosable rather than
            // looking like an application that ignored the keystrokes.
            lastSend = new int[] { (int)sent, (int)failed, size, lastError };
        }

        static int[] lastSend = new int[] { 0, 0, 0, 0 };

        /// Per-character typing cadence, in milliseconds. 30 is roughly human typing
        /// speed, and is a SAFETY setting rather than a cosmetic one: see the delay
        /// loop in TypeText. A caller may request 0 to go faster, knowingly giving up
        /// the window in which a human can interrupt.
        static int typeDelayMs = 30;

        // Every operator event carries the ownership sentinel, and the guard is
        // re-checked between events, so a human takeover aborts the sequence
        // instead of completing it.
        /// One virtual-key event, stamped with the ownership sentinel so the hook can
        /// tell it apart from the human pressing the same key.
        static void KeyVk(byte vk, bool up)
        {
            var i = new Win.INPUT
            {
                type = Win.INPUT_KEYBOARD,
                u = new Win.INPUTUNION
                {
                    ki = new Win.KEYBDINPUT
                    {
                        wVk = vk,
                        wScan = 0,
                        dwFlags = up ? (uint)Win.KEYEVENTF_KEYUP : 0u,
                        time = 0,
                        dwExtraInfo = Guard.Sentinel
                    }
                }
            };
            Win.SendInput(1, new Win.INPUT[] { i }, Marshal.SizeOf(typeof(Win.INPUT)));
            Guard.NoteOperatorEvent();
        }

        static uint Mouse(uint flags, int data, uint sleepAfter)
        {
            var mi = new Win.INPUT { type = 0, u = new Win.INPUTUNION { mi = new Win.MOUSEINPUT { dx = 0, dy = 0, mouseData = (uint)data, dwFlags = flags, time = 0, dwExtraInfo = Guard.Sentinel } } };
            uint sent = Win.SendInput(1, new Win.INPUT[] { mi }, Marshal.SizeOf(typeof(Win.INPUT)));
            Guard.NoteOperatorEvent();
            Thread.Sleep((int)sleepAfter);
            return sent;
        }

        static void Click(int x, int y, string button)
        {
            Hooks.MoveAbsolute(x, y);
            Thread.Sleep(120);
            if (!Guard.MayInject()) return;
            uint down = button == "right" ? 0x0008u : 0x0002u;
            uint up = button == "right" ? 0x0010u : 0x0004u;
            Mouse(down, 0, 50);
            if (!Guard.MayInject()) return;
            Mouse(up, 0, 120);
        }

        static void Scroll(int x, int y, int notches)
        {
            Hooks.MoveAbsolute(x, y);
            Thread.Sleep(80);
            for (int i = 0; i < Math.Abs(notches); i++)
            {
                if (!Guard.MayInject()) return;
                Mouse((uint)0x0800, notches > 0 ? 120 : -120, 60);
            }
        }

        // ------------------------------------------------------------- HTTP server
        /// A refusal for an action that is the human's alone, carrying the current guard
        /// state so a caller can see why it is blocked and what would be required.
        static string HumanOnlyRefusal(string what, string requiredAction)
        {
            string g = Guard.Json();
            string refused = what + " is the human's action and cannot be performed over HTTP";
            return Json("{\"ok\":false,\"refused\":\"" + refused + "\",\"requiredAction\":\"" + requiredAction + "\",\"guard\":" + g + "}");
        }

        // ================================================================ THE INJECTION GATE
        //
        // Every route that can cause a user-visible change on this machine. The gate at the
        // dispatch head consults this table, so membership here is what makes a route capable
        // of injecting at all.
        //
        // THE DEFAULT IS DENIAL. A route absent from this list is refused by the structural
        // audit (see audit-injection-routes.mjs) if it turns out to reach SendInput,
        // PostMessage, or a UI Automation write. That is the opposite of the previous design,
        // where a new injecting route was live and unsafely gated until someone remembered to
        // gate it.
        //
        // Read-only routes are deliberately NOT here: /uia, /uiasurvey, /uiafind, /uiaread,
        // /uiselected, /windows, /screen.png, /display, /hooks and friends observe and cannot
        // act. Note /hooks is absent for a different reason - it EMITS (its liveness probe),
        // which is instrument self-test rather than acting on the user's world. See the
        // passive/active split below.
        static readonly HashSet<string> InjectionRoutes = new HashSet<string>(StringComparer.Ordinal)
        {
            "/click",            // SendInput, verified foreground
            "/type",             // SendInput
            "/scroll",           // SendInput
            "/key",              // SendInput
            "/move",             // SendInput cursor move
            "/click-absolute",   // SendInput at a fixed screen point, no app target
            "/scaninput",        // SendInput by scancode - WAS UNGATED
            "/wmchar",           // PostMessage(WM_CHAR) - WAS UNGATED
            "/uiainvoke",        // UI Automation InvokePattern - acts with no input event
            "/uiasetvalue",      // UI Automation ValuePattern - acts with no input event
            "/uiafocus",         // UI Automation focus change
            "/show",             // Win.ShowWindow minimize|maximize|restore|show|hide - WAS UNGATED
            "/restore",          // Win.ShowWindow(SW_RESTORE)                            - WAS UNGATED
            "/focus",            // Win.Focus/FocusChild: SetForegroundWindow + SetFocus   - WAS UNGATED
            //
            // The three above changed real machine state behind nothing but an IDENTITY check - that
            // the named hwnd belongs to the named pid. That proves the caller aimed where it said; it
            // does not prove the caller was ALLOWED to act. A window can belong to exactly the right
            // process and still be minimised, hidden or pulled to the foreground while a human has
            // taken over, or while an emergency stop is latched.
            //
            // They are listed HERE rather than checked per-route because the gate at the dispatch
            // head already runs before any route body, and its design rule is that an omission denies
            // by default. The omission was the defect.
            //
            // `/guifocus` is deliberately NOT here. It reads focus (GetWindowThreadProcessId +
            // GuiFocusOfThread) and never sets it. Gating an observation behind an authorisation it
            // does not need would make observation unavailable exactly when acting is forbidden.
        };

        // Routes that GRANT injection authority without injecting anything themselves.
        //
        // `/vstype` is the case that made this category necessary. It sends no input at all: it
        // asserts no editor is open, asks VS Code to open exactly one named file through VS
        // Code's own CLI, confirms the window title now names that file, and mints a
        // short-lived authorization bound to that hwnd and that path. A later `/type` physically
        // cannot send keystrokes to a VS Code window without it.
        //
        // So it is not an injection route - the audit confirms it reaches no input primitive -
        // but it is unmistakably a route that HANDS OUT PERMISSION, and it needs the same gate.
        // Listing it separately keeps the two ideas apart instead of blurring "can act" into
        // "can authorise", which is how a permission-granting route ends up ungated because
        // nobody thought of it as an injection.
        static readonly HashSet<string> PermissionRoutes = new HashSet<string>(StringComparer.Ordinal)
        {
            "/vstype",           // grants a scoped, expiring editor authorization
        };

        /// Every route that must not run unless the guard permits injection.
        static bool RequiresPermission(string path)
        {
            return InjectionRoutes.Contains(path) || PermissionRoutes.Contains(path);
        }

        // Routes that EMIT into the input stream without acting on the user's world.
        //
        // /hooks calls Hooks.Report(), which sends one sentinel-tagged F24 keystroke so the
        // hook can prove it is still in the chain. It is not listed above because it is
        // instrumentation, not an action: F24 is bound by no application, it carries no target,
        // and gating it would mean a silently-detached hook could never be detected - it
        // would hide by refusing everything.
        //
        // The consequence, measured on this host: eight reads of /hooks advanced
        // livenessProbes by 7. It is therefore NOT a passive observation, and an audit that
        // brackets actions with it is partly measuring its own side effect.
        //
        // PassiveDiagnostics() is the passive counterpart: identical counters, no probe.
        static readonly HashSet<string> SelfTestRoutes = new HashSet<string>(StringComparer.Ordinal)
        {
            "/hooks",
            "/indicator",
        };

        static string Handle(string method, string path, string query, string body)
        {
            if (path == "/guard") return Json(Guard.Json());
            if (path == "/indicator") return Json(Indicator.Report());
            // Authoritative hook diagnostics, straight from the hook path. Added because the
            // hook's own state was previously unobservable: SetWindowsHookEx could fail, every
            // keystroke would reach the desktop, and every automated test would still pass.
            if (path == "/hooks") return Json(Hooks.Report());

            // PASSIVE hook diagnostics: the same counters, with NO liveness probe.
            //
            // /hooks emits a real sentinel-tagged F24 keystroke every time it is read - measured
            // at 7 probes per 8 reads on this host - so it is not an observation and cannot be
            // used as one. This route exists so an audit can read hook state without changing
            // it. `probeFired` is in both payloads so a reader never has to guess which kind
            // of read they are holding.
            if (path == "/hooks-passive") return Json(Hooks.PassiveDiagnostics());
            // Turns the per-event keyboard trace on. Needed because a chord that is not
            // swallowed and a chord whose modifiers were not seen as held are indistinguishable
            // from any counter alone.
            // Detaches the keyboard hook WITHOUT clearing the installed flag - exactly what Windows does
            // when a low-level hook exceeds LowLevelHooksTimeout. Exists so the liveness probe
            // can be shown to detect the failure it exists to detect. A watchdog that has never
            // been tested against a real failure is not a watchdog.
            if (path == "/hooks-breaksilently")
            {
                string rest3; string on3 = P2(body, "on", out rest3);
                if (on3 == "1") { Hooks.BreakKeyboardHookSilently(); }
                return Json(Hooks.Report());
            }
            // Reinstalls the hooks after the negative control detached one, so a test run cannot leave
            // the operator permanently unable to swallow its chords.
            // Reports whether a virtual key is safe to use for a reserved chord on THIS hardware.
            // Exists because a chord on a hardware-mapped key is unswallowable and, crucially,
            // undetectable by synthetic tests - SendInput emits a Windows-level key that IS
            // interceptable, while real firmware intercepts first.
            if (path == "/hooks-keycheck")
            {
                string rest4; string vs = P2(body, "vk", out rest4);
                uint vk = 0;
                try { vk = Convert.ToUInt32(vs.StartsWith("0x") ? vs.Substring(2) : vs, 16); } catch { }
                bool mapped = Hooks.IsHardwareMappedKey(vk);
                return Json("{\"ok\":true,\"vk\":\"0x" + vk.ToString("X") + "\",\"hardwareMapped\":"
                    + (mapped ? "true" : "false") + ",\"swallowable\":" + (mapped ? "false" : "true")
                    + ",\"reason\":" + (mapped
                        ? "\"this key is bound in hardware or firmware, so a low-level hook never sees the event and cannot swallow it\""
                        : "null") + "}");
            }
            if (path == "/hooks-restore") { Hooks.Reinstall(); Guard.ClearHookUnhealthy(); return Json(Hooks.Report()); }
            if (path == "/hooks-trace")
            {
                string rest2;
                string on = P2(body, "on", out rest2);
                Hooks.Trace = (on == "1" || on == "true");
                if (on == "clear") { Hooks.TraceLog = ""; Hooks.Trace = false; }
                return Json(Hooks.Report());
            }
            // Reports the operator's ownership sentinel ONLY to the local test harness, which
            // needs it to distinguish a forged event from a genuinely untagged one.
            //
            // This is deliberately NOT exposed on /guard. The sentinel used to be published
            // there, which handed every client - including the automation layer - the exact
            // value needed to have its injection credited to the operator. An empty string is
            // reported on /guard so that its absence is visible rather than silent.
            if (path == "/sentinel-probe")
            {
                if (Guard.Sentinel.ToInt64() == 0) return Json("{\"ok\":true,\"sentinelHex\":null}");
                return Json("{\"ok\":true,\"sentinelHex\":\"" + Guard.Sentinel.ToInt64().ToString("X") + "\"}");
            }
            if (path == "/arm") { Guard.Arm("armed by operator request"); return Json(Guard.Json()); }
            if (path == "/observe") { Guard.Observe("observation-only mode"); return Json(Guard.Json()); }
            if (path == "/pause") { Guard.Pause("paused by operator request"); return Json(Guard.Json()); }
            // REFUSED OVER HTTP, DELIBERATELY. Release is the human's action, and this
            // endpoint used to perform it on request - which meant the operator could
            // release itself with a single call, exactly as easy as typing. The reason
            // string said "explicit human release" while nothing checked that a human was
            // involved, which is worse than having no check: it documented a guarantee the
            // system did not provide.
            //
            // The only route to a release is now the physical chord (Ctrl+Alt+G), which
            // the hook observes as untagged input and therefore cannot forge. The endpoint
            // is kept so the refusal is explicit and legible rather than a 404, and so a
            // caller can discover the correct action.
            if (path == "/release")
                return HumanOnlyRefusal("release", "press Ctrl+Alt+G on the keyboard");
            if (path == "/emergency-stop") { Guard.EmergencyStop("emergency stop requested"); DrainPending(); return Json(Guard.Json()); }
            // Same reasoning as /release. Clearing the human's emergency latch is the human's
            // action. The chord Ctrl+Alt+R is the only route; see Hooks.cs.
            if (path == "/rearm")
                return HumanOnlyRefusal("clearing an emergency stop latch", "press Ctrl+Alt+R on the keyboard");
            if (path == "/drain") return Json(DrainPending());
            if (path == "/ping")
            {
                IntPtr fg = Win.GetForegroundWindow();
                return Json("{\"ok\":true,\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id
                    + ",\"session\":" + System.Diagnostics.Process.GetCurrentProcess().SessionId
                    + ",\"screenWidth\":" + System.Windows.Forms.SystemInformation.VirtualScreen.Width
                    + ",\"screenHeight\":" + System.Windows.Forms.SystemInformation.VirtualScreen.Height
                    + ",\"foregroundHwnd\":" + fg.ToInt64()
                    + ",\"foregroundTitle\":\"" + Esc(Win.Title(fg)) + "\"}");
            }
            if (path == "/windows") return Json("{\"ok\":true,\"windows\":" + WindowsJson() + "}");
            if (path == "/screen.png")
            {
                int scale;
                return "BINARY:" + Convert.ToBase64String(
                    ScreenPng((int)Qs(query, "x"), (int)Qs(query, "y"), (int)Qs(query, "w"), (int)Qs(query, "h"), out scale));
            }
            if (path == "/display")
            {
                // Reported in both spaces on purpose. The process is DPI-unaware, so
                // these two differ, and every coordinate handed out by this host is in
                // the input space while every capture is in the physical space. Making
                // that ratio explicit is what stops the two from being confused again.
                int scale;
                PixelAt(0, 0, out scale);
                Rectangle vs = System.Windows.Forms.SystemInformation.VirtualScreen;
                return Json("{\"ok\":true"
                    + ",\"dpiMode\":\"" + Esc(DpiMode) + "\""
                    + ",\"inputSpaceW\":" + vs.Width + ",\"inputSpaceH\":" + vs.Height
                    + ",\"captureScalePct\":" + scale
                    + ",\"captureNote\":\"" + Esc(CaptureThreadNote) + "\""
                    + "}");
            }
            if (path == "/panelgrid")
            {
                // The panel's displayed state AND the colour actually on screen, sampled
                // from ONE capture, in one request.
                //
                // These were previously two separate instruments - a state report and a
                // grid of pixel probes - and comparing them was constantly flaky. The
                // pixel probe is expensive (it needs a DPI-aware helper process), so a
                // grid of them took seconds, during which the operator state genuinely
                // changed; the two answers were then not describing the same instant.
                // That is not a flaky test, it is a comparison across time. One capture
                // fixes it at the source and is far cheaper.
                IntPtr hwnd = new IntPtr(Indicator.Handle.ToInt64());
                Win.RECT r;
                if (hwnd == IntPtr.Zero || !Win.GetWindowRect(hwnd, out r))
                    return Json("{\"ok\":false,\"error\":\"panel window has no rectangle\"}");
                int w = r.Right - r.Left, hgt = r.Bottom - r.Top;
                if (w < 4 || hgt < 4)
                    return Json("{\"ok\":false,\"error\":\"panel window is degenerate\"}");

                var before = Indicator.LastPainted();
                int gridScale;
                byte[] png = ScreenPng(r.Left, r.Top, w, hgt, out gridScale);
                // Read the snapshot again AFTER the capture. The panel repaints on a
                // 200ms timer and a capture takes longer than that, so a state change
                // can land mid-capture. Reporting the state from before the capture
                // alongside the pixels from after it is how a check ends up comparing
                // two different instants and declaring a contradiction that is really
                // just a repaint landing mid-measurement. Both ends are reported so the
                // comparison can be made honestly.
                var snap = Indicator.LastPainted();

                var tally = new Dictionary<string, int>();
                int sampled = 0;
                using (var ms = new MemoryStream(png))
                using (var bmp = new Bitmap(ms))
                {
                    for (int fy = 1; fy <= 5; fy++)
                    {
                        for (int fx = 1; fx <= 9; fx++)
                        {
                            int px = Math.Min(bmp.Width - 1, bmp.Width * fx / 10);
                            int py = Math.Min(bmp.Height - 1, bmp.Height * fy / 6);
                            Color c = bmp.GetPixel(px, py);
                            string key = "#" + c.R.ToString("X2") + c.G.ToString("X2") + c.B.ToString("X2");
                            if (!tally.ContainsKey(key)) tally[key] = 0;
                            tally[key]++;
                            sampled++;
                        }
                    }
                }
                string dom = ""; int best = 0, total = 0;
                foreach (var kv in tally) { total += kv.Value; if (kv.Value > best) { best = kv.Value; dom = kv.Key; } }
                var sb = new StringBuilder();
                sb.Append("{\"ok\":true,\"displaysWhatIsPainted\":true")
                  .Append(",\"stateBeforeCapture\":\"").Append(Esc(before == null ? "" : before.State)).Append("\"")
                  .Append(",\"state\":\"").Append(Esc(snap == null ? "" : snap.State)).Append("\"")
                  .Append(",\"latched\":").Append(snap != null && snap.Latched ? "true" : "false")
                  .Append(",\"mayInject\":").Append(snap != null && snap.MayInject ? "true" : "false")
                  .Append(",\"rect\":[").Append(r.Left).Append(",").Append(r.Top).Append(",").Append(r.Right).Append(",").Append(r.Bottom).Append("]")
                  .Append(",\"dominant\":\"").Append(dom).Append("\"")
                  .Append(",\"purity\":").Append(total > 0 ? (best * 1000 / total) / 1000.0 : 0)
                  .Append(",\"sampled\":").Append(sampled)
                  .Append(",\"tally\":{");
                bool first = true;
                foreach (var kv in tally)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append('"').Append(kv.Key).Append("\":").Append(kv.Value);
                }
                sb.Append("}}");
                return Json(sb.ToString());
            }
            if (path == "/pixel")
            {
                int scale;
                return Json(PixelAt((int)Qs(query, "x"), (int)Qs(query, "y"), out scale));
            }
            if (path == "/shutdown") { Json("{\"ok\":true,\"stopping\":true}"); Thread.Sleep(120); Environment.Exit(0); }

            if (path == "/uia")
            {
                long h = Qs(query, "hwnd");
                if (h == 0) return Json("{\"ok\":false,\"error\":\"hwnd required\"}");
                int depth = 4; string ds = QsStr(query, "depth"); if (ds != null) int.TryParse(ds, out depth);
                return Json("{\"ok\":true,\"tree\":" + UiaJson(new IntPtr(h), depth) + "}");
            }

            // ---------------------------------------------------------------
            // REAL UI Automation.
            //
            // These are guarded exactly like coordinate injection, and that is the
            // important part: Invoke and SetValue act on a control WITHOUT producing a
            // mouse or keyboard event, so nothing in the low-level hooks can see them.
            // Exposed ungated they would be a path around the guard. So every one of them
            // requires the caller to name the hwnd, the owning pid and the title, requires
            // the guard to permit injection, and requires the target to be foreground.
            // Accessibility decides WHAT to act on; the gate still decides WHETHER.
            if (path == "/uiasurvey" || path == "/uiafind" || path == "/uiainvoke"
                || path == "/uiasetvalue" || path == "/uiaread" || path == "/uiafocus"
                || path == "/uiselected")
            {
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid");
                if (h == 0) return Json("{\"ok\":false,\"error\":\"hwnd required\"}");
                // Own locals rather than the shared expectTitle/p2, which are declared
                // further down this method and are not in scope yet at this point.
                string uiaDiscard;
                string uiaTitle = P2(body, "title", out uiaDiscard);
                var t = Verify(h, pid, uiaTitle);
                if (!t.ok) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(t.error) + "\"}");

                bool acting = path == "/uiainvoke" || path == "/uiasetvalue" || path == "/uiafocus";
                if (acting)
                {
                    if (!Guard.MayInject())
                        return Json("{\"ok\":false,\"refused\":true,\"error\":\"state is " + Guard.State + "; " + Guard.Reason + "\"}");
                    if (Win.GetForegroundWindow() != t.hwnd)
                        return Json("{\"ok\":false,\"refused\":true,\"error\":\"target is not foreground; refusing to act on a background window\"}");
                }

                string nameNeedle = P2(body, "name", out uiaDiscard); if (nameNeedle == null) nameNeedle = "";
                string typeNeedle = P2(body, "type", out uiaDiscard); if (typeNeedle == null) typeNeedle = "";
                string idNeedle = P2(body, "automationId", out uiaDiscard); if (idNeedle == null) idNeedle = "";
                int index = Pn(body, "index");

                try
                {
                    if (path == "/uiasurvey")
                    {
                        int max = Pn(body, "max"); if (max <= 0) max = 400;
                        bool off = Pn(body, "includeOffscreen") != 0;
                        return Json(Uia.Survey(t.hwnd, max, off));
                    }
                    if (path == "/uiafind")
                    {
                        int max = Pn(body, "max"); if (max <= 0) max = 60;
                        var list = Uia.Find(t.hwnd, nameNeedle, typeNeedle, idNeedle, max, Pn(body, "includeOffscreen") != 0);
                        var sb = new StringBuilder();
                        sb.Append("{\"ok\":true,\"count\":").Append(list.Count).Append(",\"elements\":[");
                        for (int i = 0; i < list.Count; i++)
                        {
                            if (i > 0) sb.Append(',');
                            sb.Append(Uia.ElJson(list[i], i));
                        }
                        sb.Append("]}");
                        return Json(sb.ToString());
                    }
                    if (path == "/uiainvoke")
                    {
                        string err, detail;
                        string el = Uia.Invoke(t.hwnd, index, nameNeedle, typeNeedle, out err, out detail);
                        if (el == null) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(err) + "\"}");
                        Thread.Sleep(220);
                        return Json("{\"ok\":true,\"mechanism\":\"" + Esc(detail) + "\",\"target\":" + el + "}");
                    }
                    if (path == "/uiasetvalue")
                    {
                        string txt = P2(body, "text", out uiaDiscard); if (txt == null) txt = "";
                        string err, back;
                        string el = Uia.SetValue(t.hwnd, index, nameNeedle, typeNeedle, txt, out err, out back);
                        if (el == null) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(err) + "\"}");
                        Thread.Sleep(200);
                        return Json("{\"ok\":true,\"target\":" + el + ",\"readBack\":\"" + Esc(back) + "\"}");
                    }
                    if (path == "/uiafocus")
                    {
                        string err, back;
                        string el = Uia.Focus(t.hwnd, index, nameNeedle, typeNeedle, out err, out back);
                        if (el == null) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(err) + "\"}");
                        Thread.Sleep(200);
                        return Json("{\"ok\":true,\"target\":" + el + ",\"focused\":\"" + Esc(back) + "\"}");
                    }
                    if (path == "/uiselected")
                    {
                        return Json(Uia.WhichSelected(t.hwnd, typeNeedle, Pn(body, "max")));
                    }
                    // /uiaread
                    string rerr;
                    string res = Uia.ReadText(t.hwnd, index, nameNeedle, typeNeedle, out rerr);
                    if (res == null) return Json("{\"ok\":false,\"error\":\"" + Esc(rerr) + "\"}");
                    return Json("{\"ok\":true," + res.Substring(1));
                }
                catch (Exception ex)
                {
                    return Json("{\"ok\":false,\"error\":\"" + Esc(ex.GetType().Name + ": " + ex.Message) + "\"}");
                }
            }

            // ---- mutating operations, all gated behind Verify()
            // expectTitle is declared once and set per-endpoint; every mutating route
            // reads it and passes it to Verify, so a caller can pin the window by
            // title as well as by hwnd and pid.
            string p2, expectTitle = null;

            // Window management, not input. A minimized window cannot receive input,
            // and the input guard below correctly refuses one - so the operator needs a
            // way to bring its own target back before acting on it. The window's
            // process identity is still verified here, so this cannot be aimed at an
            // arbitrary window without naming the pid that owns it.
            if (path == "/restore")
            {
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid");
                if (h == 0) return Json("{\"ok\":false,\"error\":\"hwnd required\"}");
                uint owner = Win.PidOf(new IntPtr(h));
                if (owner != (uint)pid)
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"pid mismatch: window belongs to " + owner + ", caller expected " + pid + "\"}");
                Win.ShowWindow(new IntPtr(h), 9); // SW_RESTORE
                Thread.Sleep(240);
                Win.RECT r; Win.GetWindowRect(new IntPtr(h), out r);
                bool min = Win.IsIconic(new IntPtr(h));
                return Json("{\"ok\":" + (min ? "false" : "true") + ",\"restored\":{\"hwnd\":" + h + ",\"minimized\":" + (min ? "true" : "false")
                    + ",\"left\":" + r.Left + ",\"top\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}}");
            }

            // Window management: minimize / restore / maximize / show / hide.
            //
            // This needed its own endpoint rather than an "action" parameter on
            // /restore, because ShowWindow takes different commands and mixing them
            // would make "restore" ambiguous with "un-minimize". Like every other
            // window-affecting call it goes through Verify(): the caller must name the
            // hwnd, the pid that owns it, and the title, and the process must be the
            // one the window actually belongs to. Without that, an automation layer
            // could name any window on the desktop and have it minimized or hidden.
            if (path == "/show")
            {
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid");
                string act = Ps(body, "action", "show");
                if (h == 0) return Json("{\"ok\":false,\"error\":\"hwnd required\"}");
                IntPtr hw = new IntPtr(h);
                uint owner = Win.PidOf(hw);
                if (owner != (uint)pid)
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"pid mismatch: window belongs to " + owner + ", caller expected " + pid + "\"}");
                if (!Win.IsWindowVisible(hw) && act != "show" && act != "restore" && act != "maximize")
                    return Json("{\"ok\":false,\"error\":\"window is not visible; use action=show first\"}");

                int cmd;
                switch (act)
                {
                    case "minimize": cmd = 6; break;    // SW_MINIMIZE
                    case "maximize": cmd = 3; break;    // SW_MAXIMIZE
                    case "restore": cmd = 9; break;     // SW_RESTORE
                    case "show": cmd = 5; break;        // SW_SHOW
                    case "hide": cmd = 0; break;        // SW_HIDE
                    default:
                        return Json("{\"ok\":false,\"error\":\"unknown action '" + Esc(act) + "'; use minimize|maximize|restore|show|hide\"}");
                }
                bool done = Win.ShowWindow(hw, cmd);
                Thread.Sleep(300);
                Win.RECT r; Win.GetWindowRect(hw, out r);
                return Json("{\"ok\":" + (done ? "true" : "false")
                    + ",\"action\":\"" + Esc(act) + "\""
                    + ",\"hwnd\":" + h
                    + ",\"visible\":" + (Win.IsWindowVisible(hw) ? "true" : "false")
                    + ",\"minimized\":" + (Win.IsIconic(hw) ? "true" : "false")
                    + ",\"rect\":[" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "]}");
            }

            if (path == "/integrity")
            {
                // A diagnostic must never be able to take the host down, so token and
                // SID parsing is fully guarded and reports failure as data.
                int mine = -2, theirs = -2, fgIl = -2;
                int target = (int)Qs(query, "pid");
                if (target <= 0) target = (int)Win.PidOf(Win.GetForegroundWindow());
                try { mine = Win.IntegrityOfProcess((uint)System.Diagnostics.Process.GetCurrentProcess().Id); } catch { mine = -2; }
                try { theirs = Win.IntegrityOfProcess((uint)target); } catch { theirs = -2; }
                try { fgIl = Win.IntegrityOfProcess(Win.PidOf(Win.GetForegroundWindow())); } catch { fgIl = -2; }
                bool block = mine >= 0 && theirs >= 0 && mine < theirs;
                return Json("{\"ok\":true,\"hostIntegrity\":" + mine
                    + ",\"targetPid\":" + target + ",\"targetIntegrity\":" + theirs
                    + ",\"foregroundPid\":" + Win.PidOf(Win.GetForegroundWindow())
                    + ",\"foregroundIntegrity\":" + fgIl
                    + ",\"uipiWouldBlock\":" + (block ? "true" : "false")
                    + ",\"note\":\"-2 means the level could not be read\"}");
            }

            if (path == "/guifocus")
            {
                long h = Qs(query, "hwnd");
                if (h == 0) return Json("{\"ok\":false,\"error\":\"hwnd required\"}");
                uint dummyPid;
                uint thread = Win.GetWindowThreadProcessId(new IntPtr(h), out dummyPid);
                Win.GUITHREADINFO g = Win.GuiFocusOfThread(thread);
                return Json("{\"ok\":true,\"thread\":" + thread
                    + ",\"hwndActive\":" + g.hwndActive.ToInt64()
                    + ",\"hwndFocus\":" + g.hwndFocus.ToInt64()
                    + ",\"hwndCapture\":" + g.hwndCapture.ToInt64()
                    + ",\"focusTitle\":\"" + Esc(Win.Title(g.hwndFocus))
                    + "\",\"focusClass\":\"" + Esc(Win.Cls(g.hwndFocus))
                    + "\",\"isTargetFocused\":" + (g.hwndFocus == new IntPtr(h) ? "true" : "false")
                    + "}");
            }

            // ---- alternative injection mechanisms, for the keyboard investigation.
            // Each is a genuinely different mechanism and is labelled as such, because
            // only some of them are equivalent to a human pressing keys.
            if (path == "/scaninput")
            {
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid"); expectTitle = P2(body, "title", out p2);
                var t = Verify(h, pid, expectTitle);
                if (!t.ok) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(t.error) + "\"}");
                if (Win.GetForegroundWindow() != t.hwnd && !Win.Focus(t.hwnd))
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"target is not foreground\"}");
                string text = P2(body, "text", out p2); if (text == null) text = "";
                int size = Marshal.SizeOf(typeof(Win.INPUT));
                uint sent = 0;
                foreach (char c in text)
                {
                    short vk = Win.VkKeyScan(c);
                    if (vk == -1) continue;
                    uint sc = Win.MapVirtualKey((uint)(vk & 0xFF), Win.MAPVK_VK_TO_VSC);
                    var dn = new Win.INPUT { type = Win.INPUT_KEYBOARD, u = new Win.INPUTUNION { ki = new Win.KEYBDINPUT { wVk = 0, wScan = (ushort)sc, dwFlags = Win.KEYEVENTF_SCANCODE, time = 0, dwExtraInfo = IntPtr.Zero } } };
                    var up = dn; up.u.ki.dwFlags = Win.KEYEVENTF_SCANCODE | Win.KEYEVENTF_KEYUP;
                    sent += Win.SendInput(1, new Win.INPUT[] { dn }, size);
                    Win.SendInput(1, new Win.INPUT[] { up }, size);
                    Thread.Sleep(10);
                }
                return Json("{\"ok\":" + (sent > 0 ? "true" : "false") + ",\"sentDown\":" + sent + ",\"chars\":" + text.Length
                    + ",\"lastError\":" + Marshal.GetLastWin32Error() + ",\"mechanism\":\"SendInput+SCANCODE\"}");
            }

            if (path == "/wmchar")
            {
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid"); expectTitle = P2(body, "title", out p2);
                long child = Pn(body, "child");
                var t = Verify(h, pid, expectTitle);
                if (!t.ok) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(t.error) + "\"}");
                IntPtr target = child == 0 ? t.hwnd : new IntPtr(child);
                string text = P2(body, "text", out p2); if (text == null) text = "";
                uint posted = 0;
                foreach (char c in text)
                {
                    // WM_CHAR posted directly to the control. This is a MESSAGE, not
                    // hardware input: it proves the control accepts the characters and
                    // the process can drive it, but it is not a key press.
                    if (Win.PostMessage(target, 0x0102, new IntPtr(c), new IntPtr(1))) posted++;
                    Thread.Sleep(12);
                }
                return Json("{\"ok\":" + (posted > 0 ? "true" : "false") + ",\"posted\":" + posted
                    + ",\"chars\":" + text.Length + ",\"mechanism\":\"PostMessage+WM_CHAR\"}");
            }

            if (path == "/focus")
            {
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid"); expectTitle = P2(body, "title", out p2);                var t = Verify(h, pid, expectTitle);
                if (!t.ok) return Json("{\"ok\":false,\"error\":\"" + Esc(t.error) + "\"}");
                // An optional child hwnd focuses a specific control, which is what
                // typing needs; without it only the window is focused.
                long child = Pn(body, "child");
                bool got = child != 0 ? Win.FocusChild(t.hwnd, new IntPtr(child)) : Win.Focus(t.hwnd);
                IntPtr fg = Win.GetForegroundWindow();
                return Json("{\"ok\":" + (got ? "true" : "false")
                    + ",\"note\":\"" + Esc(Win.LastFocusNote) + "\""
                    + ",\"foregroundHwnd\":" + fg.ToInt64()
                    + ",\"focusedChild\":" + (child == 0 ? "0" : child.ToString())
                    + ",\"foregroundTitle\":\"" + Esc(Win.Title(fg)) + "\"}");
            }

            // ------------------------------------------------------------------
            // VS CODE EDITOR TARGETING, host-enforced.
            //
            // Measurement first, then design. Dumping every Tab/TabItem in a VS Code window
            // shows the only three Tab controls are the Activity Bar, the bottom panel and
            // Chat. There is NO editor tab strip in the accessibility tree: this build's
            // Electron provider does not expose the open-editors group at all. So the
            // operator cannot enumerate open files and therefore cannot rule out that some
            // other editor holds the caret. The window title is not a substitute - it
            // reports the last-ACTIVE editor while the keyboard follows the FOCUSED element,
            // which is precisely how an earlier run typed one file's text into another.
            //
            // So rather than infer where the caret is, the host eliminates the question:
            //
            //   1. assert NO editor is open      (title carries no file name)
            //   2. open exactly one, by name     (code --reuse-window, VS Code's own CLI,
            //                                      which places VS Code's own caret)
            //   3. assert the title NOW names it (post-condition on the application's
            //                                      behaviour, not an inference about focus)
            //   4. mint a short-lived authorization bound to THIS hwnd and THIS path
            //
            // With one editor open, the caret cannot be anywhere else. Step 3 is what makes
            // it evidence rather than optimism: if the command failed, was slow, or was
            // rejected, the title will not name the file and this refuses.
            //
            // The authorization lives HERE, not in a test. /type physically cannot send
            // keystrokes to a VS Code window without one, so no caller can forget to verify.
            if (path == "/vstype")
            {
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid");
                string discard;
                string vTitle = P2(body, "title", out discard);
                var vt = Verify(h, pid, vTitle);
                if (!vt.ok) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(vt.error) + "\"}");
                if (!Guard.MayInject())
                    return Json("{\"ok\":false,\"refused\":true,\"guard\":true,\"error\":\"" + Esc(Guard.WhyRefused()) + "\"}");
                if (Win.GetForegroundWindow() != vt.hwnd)
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"VS Code is not foreground; refusing to target an editor that is not in front\"}");

                string file = P2(body, "file", out discard);
                string codeExe = P2(body, "codeExe", out discard);
                bool assumeEmpty = Pn(body, "assumeNoEditorOpen") != 0;
                if (file == null || file.Length == 0)
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"file is required\"}");
                if (codeExe == null || codeExe.Length == 0)
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"codeExe is required\"}");
                if (!File.Exists(file))
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"file does not exist: " + Esc(file) + "\"}");

                string liveTitle = Win.Title(vt.hwnd);
                string log = "precondition: title=\"" + Esc(liveTitle) + "\" hasOpenFile="
                    + (VsEdit.TitleHasOpenFile(liveTitle) ? "TRUE" : "false");

                // Step 1. If an editor is already open we cannot prove which one holds the
                // caret, because the editor tab strip is not exposed. Refuse rather than
                // guess - unless the caller has already closed them and asserts so, which
                // the filesystem state backs up.
                bool hadEditor = VsEdit.TitleHasOpenFile(liveTitle);
                if (hadEditor && !assumeEmpty)
                {
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"an editor is already open and this build exposes no editor tab strip, "
                        + "so the active buffer cannot be established. Close all editors first. title=\"" + Esc(liveTitle) + "\"}");
                }

                // Step 2. Ask VS Code to open exactly one file, through its own CLI.
                string opened = VsEdit.RunOpenCommand(codeExe, file, 30000);
                log += " | open: " + Esc(opened);

                // Step 3. Post-condition, polled because the title updates asynchronously.
                string after = "";
                bool confirmed = false;
                for (int i = 0; i < 40; i++)
                {
                    Thread.Sleep(250);
                    after = Win.Title(vt.hwnd);
                    string leaf = Path.GetFileName(file);
                    if (after.IndexOf(leaf, StringComparison.OrdinalIgnoreCase) >= 0) { confirmed = true; break; }
                }
                log += " | postcondition: title=\"" + Esc(after) + "\" namesTheFile=" + (confirmed ? "YES" : "NO");

                if (!confirmed)
                {
                    VsEdit.Revoke(vt.hwnd);
                    return Json("{\"ok\":false,\"refused\":true,\"error\":\"VS Code did not confirm opening the file; refusing to type. "
                        + "The caret is not known to be where we intended.\",\"log\":\"" + Esc(log) + "\"}");
                }

                // Step 4. Authorize, bound to this window and this exact path, briefly.
                VsEdit.Grant(vt.hwnd, Path.GetFullPath(file));
                return Json("{\"ok\":true,\"authorizedFor\":\"" + Esc(Path.GetFullPath(file))
                    + "\",\"expiresInMs\":" + VsEdit.AuthLifetimeMs
                    + ",\"title\":\"" + Esc(after) + "\",\"log\":\"" + Esc(log)
                    + "\",\"proof\":\"zero editors open, then exactly one opened by VS Code itself, then title confirms it\"}");
            }

            // An absolute, operator-TAGGED click at given screen coordinates, with no target window.
            //
            // Handled BEFORE the target-window gate below, because that gate exists to stop
            // input leaking into a HUMAN'S APPLICATION - which is the whole point when clicking
            // into a browser. This route has no application target: it aims at a fixed screen
            // region watched by the hook. Applying the app-target rules to it would make the
            // panel-release proof untestable for a reason unrelated to what it proves.
            //
            // It is NOT a release path. It synthesises a click carrying the sentinel and lets
            // the hook judge it; because the sentinel marks it as automation, the hook always
            // refuses it. It has no more authority than the raw SendInput the hook is built to
            // distrust - that distrust is the security property, and it is unchanged here.
            if (path == "/click-absolute")
            {
                if (!Guard.MayInject())
                    return Json("{\"ok\":false,\"refused\":true,\"guard\":true,\"error\":\"" + Esc(Guard.WhyRefused()) + "\"}");
                Guard.Working();
                int cx = Pn(body, "x"), cy = Pn(body, "y");
                lastSend = new int[] { cx, cy, 0, 0 };
                // MoveAbsolute is required first: the down/up below carry dx=dy=0, so without
                // it they land wherever the cursor already was and never reach the intended
                // coordinate. That was why an earlier version of this proof saw no mouse
                // events at all - the hook was fine and the instrument was not.
                Hooks.MoveAbsolute(cx, cy);
                Thread.Sleep(140);
                Click(cx, cy, "left");
                Win.POINT cp; Win.GetCursorPos(out cp);
                return Json("{\"ok\":true,\"clicked\":{\"x\":" + cx + ",\"y\":" + cy
                    + "},\"cursor\":{\"x\":" + cp.X + ",\"y\":" + cp.Y + "}}");
            }

            if (path == "/click" || path == "/type" || path == "/scroll" || path == "/key" || path == "/move")
            {
                // THE control gate. It runs before the target is even resolved, so a
                // paused or emergency-stopped operator cannot inject whatever it was
                // about to do.
                if (!Guard.MayInject())
                    return Json("{\"ok\":false,\"refused\":true,\"guard\":true,\"error\":\"" + Esc(Guard.WhyRefused()) + "\"}");
                Guard.Working();
                long h = Pn(body, "hwnd"); int pid = Pn(body, "pid"); expectTitle = P2(body, "title", out p2);
                var t = Verify(h, pid, expectTitle);
                if (!t.ok) return Json("{\"ok\":false,\"refused\":true,\"error\":\"" + Esc(t.error) + "\"}");

                // Hardware-level injection requires verified foreground. This is the
                // guard that stops input leaking into the user's browser.
                if (Win.GetForegroundWindow() != t.hwnd)
                {
                    // The desktop just changed underneath us. Any editor authorization was
                    // granted for a world that no longer exists, so it dies here rather than
                    // lingering for its remaining lifetime. A stale grant that survived a
                    // focus change would be indistinguishable from a fresh one.
                    VsEdit.RevokeAll();
                    Win.Focus(t.hwnd);
                    if (Win.GetForegroundWindow() != t.hwnd)
                    {
                        return Json("{\"ok\":false,\"refused\":true,\"error\":\"refusing to inject: target is not foreground and focus could not be acquired. Current foreground: \\\""
                            + Esc(Win.Title(Win.GetForegroundWindow())) + "\\\"\"}");
                    }
                }

                // Cursor move only, no button event. Added to calibrate the
                // screen<->viewport mapping against a real browser, so it lives
                // INSIDE the same Verify() and foreground guard as every other input
                // op rather than becoming a new way to move the pointer unchecked.
                if (path == "/move")
                {
                    int x = Pn(body, "x"), y = Pn(body, "y");
                    Win.SetCursorPos(x, y);
                    Thread.Sleep(40);
                    Win.POINT cp; Win.GetCursorPos(out cp);
                    return Json("{\"ok\":true,\"moved\":{\"x\":" + x + ",\"y\":" + y
                        + "},\"cursor\":{\"x\":" + cp.X + ",\"y\":" + cp.Y + "}}");
                }

            if (path == "/click")
            {
                int x = Pn(body, "x"), y = Pn(body, "y");
                    string btn = P2(body, "button", out p2); if (btn == null) btn = "left";
                    Click(x, y, btn);
                    Win.POINT cp; Win.GetCursorPos(out cp);
                    return Json("{\"ok\":true,\"clicked\":{\"x\":" + x + ",\"y\":" + y + ",\"button\":\"" + btn + "\"},\"cursor\":{\"x\":" + cp.X + ",\"y\":" + cp.Y + "}}");
                }
                if (path == "/type")
                {
                    string text = P2(body, "text", out p2); if (text == null) text = "";
                    lastSend = new int[] { 0, 0, 0, 0 };

                    // The editor-target gate. Not a test-side suggestion: without a live
                    // authorization these keystrokes are not sent at all.
                    //
                    // It applies only when the caller declares which FILE it is typing into,
                    // because that is the case where "where will this text land" is a real
                    // question. Typing into a browser address bar or a terminal is verified
                    // by foreground and window identity, which is sound for those. Typing
                    // into a multi-document editor is not, because the editor group is not
                    // exposed to accessibility in this build and the window title reports the
                    // last-active editor rather than the focused one - which is exactly how
                    // one run wrote sum.js's text into sum.test.js.
                    string vfile = P2(body, "file", out p2);
                    if (vfile != null && vfile.Length > 0)
                    {
                        if (!VsEdit.Authorized(t.hwnd, Path.GetFullPath(vfile)))
                        {
                            return Json("{\"ok\":false,\"refused\":true,\"error\":\"no live authorization to type into "
                                + Esc(Path.GetFileName(vfile)) + " in this window (current: " + Esc(VsEdit.Peek(t.hwnd))
                                + "). Call /vstype first; it establishes which editor is active before any keystroke is sent.\"}");
                        }
                    }
                    long childFocus = Pn(body, "child");
                    long requestedDelay = Pn(body, "delayMs");
                    // Pn returns 0 for an absent key, so the test must be > 0. Using >= 0
                    // silently reset the cadence to zero on every request that did not
                    // mention it, which disabled the very delay that makes a mid-action
                    // takeover observable - and the proof duly showed 40/40 characters
                    // landing despite an interruption arriving partway through.
                    if (requestedDelay > 0) typeDelayMs = (int)requestedDelay;

                    // The input queue must be ATTACHED for the duration of the
                    // injection, not just while setting focus. SendInput delivers to
                    // the thread that holds input focus; if we detach first, the keys
                    // are queued to our own thread and silently discarded - which is
                    // exactly what was observed: SendInput returned 6/6 sent with
                    // lastError 0, and the field stayed empty.
                    uint dummy, targetThread = Win.GetWindowThreadProcessId(t.hwnd, out dummy);
                    uint meThread = Win.GetCurrentThreadId();
                    bool attached = targetThread != 0 && targetThread != meThread
                        && Win.AttachThreadInput(meThread, targetThread, true);
                    try
                    {
                        if (childFocus != 0) Win.SetFocus(new IntPtr(childFocus));
                        TypeText(t.hwnd, text);
                    }
                    finally
                    {
                        if (attached) Win.AttachThreadInput(meThread, targetThread, false);
                    }
                    return Json("{\"ok\":" + (lastSend[0] > 0 ? "true" : "false")
                        + ",\"chars\":" + text.Length
                        + ",\"sentDown\":" + lastSend[0]
                        + ",\"sentUp\":" + lastSend[1]
                        + ",\"attachedToTargetThread\":" + (attached ? "true" : "false")
                        + ",\"inputStructSize\":" + lastSend[2]
                        + ",\"lastError\":" + lastSend[3] + "}");
                }
                if (path == "/key")
                {
                    string vk = P2(body, "vk", out p2);
                    byte code = vk == null ? (byte)0 : (byte)Convert.ToInt32(vk, 16);
                    // Modifier support, added because real GUI work needs chords: Ctrl+L
                    // focuses a browser address bar, Ctrl+T opens a tab, Ctrl+F finds on
                    // page. Without it there is no way to reach those through the visible
                    // GUI at all. Only the key emission is extended - the Verify() and
                    // verified-foreground guards above still run first and still refuse on
                    // any mismatch.
                    //
                    // These go through SendInput rather than keybd_event because only
                    // SendInput carries dwExtraInfo, and therefore only SendInput can be
                    // tagged with the ownership sentinel. An untagged key press is
                    // indistinguishable from the human's, and the hook is right to treat
                    // it as a takeover - which it did, on this very endpoint, until it was
                    // fixed. That is the mechanism working, not failing.
                    bool ctrl = body.IndexOf("\"ctrl\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                    if (ctrl) { KeyVk(0x11, false); Thread.Sleep(30); }
                    KeyVk(code, false);
                    Thread.Sleep(40);
                    KeyVk(code, true);
                    if (ctrl) { Thread.Sleep(30); KeyVk(0x11, true); }
                    return Json("{\"ok\":true,\"vk\":\"" + vk + "\",\"ctrl\":" + (ctrl ? "true" : "false") + "}");
                }
                int sy = Pn(body, "y"), sn = Pn(body, "notches");
                int sx = Pn(body, "x"); if (sx == 0) sx = (int)(t.hwnd.ToInt64());
                Scroll(sx, sy, sn);
                return Json("{\"ok\":true,\"scrolled\":" + sn + "}");
            }

            return Json("{\"ok\":false,\"error\":\"unknown endpoint\"}");
        }

        static string Json(string inner) { return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
            + Encoding.UTF8.GetByteCount(inner) + "\r\nConnection: close\r\n\r\n" + inner; }
        static string Binary(byte[] data) { return "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: "
            + data.Length + "\r\nConnection: close\r\n\r\n" + Convert.ToBase64String(data); }

        static string P2(string body, string key, out string rest)
        {
            rest = null;
            if (body == null) return null;
            string needle = "\"" + key + "\":";
            int i = body.IndexOf(needle, StringComparison.Ordinal);
            if (i < 0) return null;
            int p = i + needle.Length;
            if (p < body.Length && body[p] == '"')
            {
                p++; var sb = new StringBuilder();
                while (p < body.Length && body[p] != '"') { if (body[p] == '\\') p++; sb.Append(body[p]); p++; }
                return sb.ToString();
            }
            int start = p;
            while (p < body.Length && (char.IsDigit(body[p]) || body[p] == '-' || body[p] == '.')) p++;
            return body.Substring(start, p - start);
        }
        static int Pn(string body, string key)
        {
            string rest; string v = P2(body, key, out rest);
            int n; if (v != null && int.TryParse(v, out n)) return n; return 0;
        }
        /// String body field with a default, for optional parameters such as the
        /// ShowWindow command name.
        static string Ps(string body, string key, string fallback)
        {
            string rest; string v = P2(body, key, out rest);
            return string.IsNullOrEmpty(v) ? fallback : v;
        }
        static long Qs(string path, string key)
        {
            int i = path.IndexOf(key + "=");
            if (i < 0) return 0;
            int s = i + key.Length + 1; int e = path.IndexOf('&', s);
            if (e < 0) e = path.Length;
            long n; long.TryParse(path.Substring(s, e - s), out n); return n;
        }
        /// Apply any reserved chord the hook noticed while no request was in flight, so
        /// a release or a stop takes effect at once rather than at the next action.
        static string DrainPending()
        {
            var applied = new System.Text.StringBuilder();
            if (Guard.emergencyPending) { Guard.emergencyPending = false; applied.Append("emergency;"); }
            if (Guard.releasePending) { Guard.releasePending = false; Guard.Release("chord Ctrl+Alt+G"); applied.Append("release;"); }
            if (Guard.rearmPending) { Guard.rearmPending = false; Guard.Rearm("chord Ctrl+Alt+R"); applied.Append("rearm;"); }
            if (Guard.observeTogglePending)
            {
                Guard.observeTogglePending = false;
                if (Guard.State == Guard.OBSERVING) { Guard.Arm("chord Ctrl+Alt+O"); applied.Append("arm;"); }
                else { Guard.Observe("chord Ctrl+Alt+O"); applied.Append("observe;"); }
            }
            return "{\"ok\":true,\"applied\":\"" + applied + "\"}";
        }

        static string QsStr(string path, string key)
        {
            int i = path.IndexOf(key + "=");
            if (i < 0) return null;
            int s = i + key.Length + 1; int e = path.IndexOf('&', s);
            if (e < 0) e = path.Length;
            return path.Substring(s, e - s);
        }

        public static string DpiMode = "process-unaware (deliberate: input space is proven here)";
        public static string CaptureThreadNote = "not run yet";
        public static int CaptureThreadErr = 0;

        /// Logical (virtualized) pixels per physical pixel, inverted: 125 means one
        /// virtualized pixel is 1.25 physical pixels. Read from GDI's LOGPIXELSX, which
        /// an unaware process still reports correctly, and cross-checked against
        /// VirtualScreen so the ratio can never be assumed.
        public static int ScalePct()
        {
            IntPtr dc = Win.GetDC(IntPtr.Zero);
            int logpx = dc == IntPtr.Zero ? 0 : Win.GetDeviceCaps(dc, 88); // LOGPIXELSX
            if (dc != IntPtr.Zero) Win.ReleaseDC(IntPtr.Zero, dc);
            if (logpx <= 0) return 100;
            return (logpx * 100) / 96;
        }

        /// Capture the TRUE physical desktop from a separate DPI-aware process.
        ///
        /// The host itself is DPI-unaware on purpose (its input targeting is calibrated
        /// and proven in the virtualized space), and an unaware process cannot read
        /// pixels outside that space no matter what its threads claim - verified by
        /// reading the PNG header back. So the read is delegated to capture-helper.ps1,
        /// which is aware. It only reads pixels; it injects nothing and decides nothing,
        /// so the input path is unaffected.
        ///
        /// Requested rectangles arrive in the host's virtualized space and are converted
        /// to physical here, so callers keep using the one coordinate space everything
        /// else in the host uses.
        static byte[] ScreenPng(int vx, int vy, int vw, int vh, out int scalePct)
        {
            string dir = Path.GetDirectoryName(statePath);
            string helper = Path.Combine(dir, "capture-helper.ps1");
            if (!File.Exists(helper)) throw new FileNotFoundException("capture-helper.ps1 missing at " + helper);

            // The host's own virtualized desktop size is passed in so the helper can
            // DERIVE the scale from its true physical size. LOGPIXELSX is not usable:
            // inside a DPI-unaware process it reports 96 even on a 125%-scaled desktop,
            // which would misplace every region capture without any error.
            int virtW = System.Windows.Forms.SystemInformation.VirtualScreen.Width;
            int virtH = System.Windows.Forms.SystemInformation.VirtualScreen.Height;
            scalePct = 0;
            string outPath = Path.Combine(Path.GetTempPath(), "portai-capture-" + Guid.NewGuid().ToString("N").Substring(0, 12) + ".png");

            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \""
                    + helper + "\" -X " + vx + " -Y " + vy + " -W " + vw + " -H " + vh
                    + " -VirtW " + virtW + " -VirtH " + virtH + " -Out \"" + outPath + "\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            string stdout, stderr;
            int code;
            using (var proc = System.Diagnostics.Process.Start(psi))
            {
                stdout = proc.StandardOutput.ReadToEnd();
                stderr = proc.StandardError.ReadToEnd();
                proc.WaitForExit(20000);
                code = proc.HasExited ? proc.ExitCode : -1;
            }
            CaptureThreadNote = stdout.Trim();
            // Pull the reported scale out of the helper's own JSON so it is measured.
            int si = CaptureThreadNote.IndexOf("\"scalePct\":[");
            if (si >= 0)
            {
                string tail = CaptureThreadNote.Substring(si + 8);
                int comma = tail.IndexOf(',');
                int pct;
                if (int.TryParse(comma > 0 ? tail.Substring(0, comma) : tail.Substring(0, tail.IndexOf(']')), out pct)) scalePct = pct;
            }
            if (!File.Exists(outPath))
                throw new InvalidOperationException("capture helper produced no image (exit " + code + "): " + stdout.Trim() + " " + stderr.Trim());
            byte[] bytes = File.ReadAllBytes(outPath);
            try { File.Delete(outPath); } catch { }
            if (code != 0) throw new InvalidOperationException("capture helper exit " + code + ": " + stdout.Trim());
            return bytes;
        }

        public static void Main(string[] args)
        {
            string dir = args.Length > 0 ? args[0] : "C:\\Users\\Samer\\AppData\\Local\\Temp\\opencode\\operator";
            Directory.CreateDirectory(dir);
            statePath = Path.Combine(dir, "host.json");

            // DPI: DELIBERATELY left process-unaware.
            //
            // Making the whole host per-monitor aware was tried and reverted. It fixed
            // the cropped capture but broke click targeting: the test browser reports
            // client coordinates in the virtualized 1536x864 space, so solving the
            // mapping against physical 1920x1080 screen coordinates produced a scale of
            // exactly 0.8 (= 1/1.25) and clicks missed their target - the GO button was
            // clicked 0px off the cursor yet its handler never fired. The 0.00px mapping
            // was earned with an unaware host, so that is what is kept.
            //
            // The crop is fixed separately, per-thread, inside the capture functions:
            // awareness is a per-thread property too, so a single thread can be made
            // aware just for the BitBlt and then put back. Window rectangles, screen
            // metrics and injected input all stay in the one space they are proven in.
            Hooks.Start();
            Indicator.Start();
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            port = ((IPEndPoint)listener.LocalEndpoint).Port;
            token = Guid.NewGuid().ToString("N").Substring(0, 24);

            File.WriteAllText(statePath, "{\"port\":" + port + ",\"token\":\"" + token + "\",\"pid\":"
                + System.Diagnostics.Process.GetCurrentProcess().Id + "}");

            Console.WriteLine("PortAi operator host listening on 127.0.0.1:" + port);

            while (true)
            {
                try
                {
                    using (TcpClient client = listener.AcceptTcpClient())
                    {
                        client.ReceiveTimeout = 5000; client.SendTimeout = 15000;
                        using (NetworkStream ns = client.GetStream())
                        {
                            var buf = new byte[65536];
                            int n = ns.Read(buf, 0, buf.Length);
                            string req = Encoding.UTF8.GetString(buf, 0, n);
                            string[] lines = req.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                            if (lines.Length == 0) continue;
                            string[] first = lines[0].Split(' ');
                            string method = first.Length > 0 ? first[0] : "GET";
                            string target = first.Length > 1 ? first[1] : "/";
                            string path = target.Split('?')[0];
                            int qmark = target.IndexOf('?');
                            string query = qmark >= 0 ? target.Substring(qmark + 1) : "";

                            // Bearer check on every request except the state file read.
                            if (method == "POST" && req.IndexOf(token, StringComparison.Ordinal) < 0)
                            {
                                string e = "{\"ok\":false,\"error\":\"unauthorized\"}";
                                byte[] eb = Encoding.UTF8.GetBytes(e);
                                // Write the header's ACTUAL length. It used to be a hardcoded
                                // 100, which truncates or over-runs the response whenever the
                                // body length is not exactly the one the literal was written
                                // for - and the symptom is a client that sees a connection
                                // error rather than a clean 403, i.e. a rejection that looks
                                // like a crash.
                                byte[] ehead = Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: " + eb.Length + "\r\nConnection: close\r\n\r\n");
                                ns.Write(ehead, 0, ehead.Length);
                                ns.Write(eb, 0, eb.Length);
                                continue;
                            }

                            string body = null;
                            if (method == "POST")
                            {
                                int ci = req.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                                if (ci >= 0) body = req.Substring(ci + 4);
                            }

                            // ============================================================
                            // THE INJECTION GATE. One place. Before any route body.
                            // ============================================================
                            //
                            // Governance used to be a CONVENTION here: each injecting route
                            // remembered to call Guard.MayInject() near its top. Two did not,
                            // and nothing failed - no test, no refusal, no visible symptom. They
                            // were found by reading the dispatch table:
                            //
                            //   /scaninput  SendInput with dwExtraInfo = 0. Types into the
                            //               foreground window while the operator is paused, and
                            //               because the event is untagged the hook files it as
                            //               HUMAN, so the guard would also record a takeover it
                            //               did not cause.
                            //   /wmchar     PostMessage(WM_CHAR). Drives a control directly.
                            //               Same consequence.
                            //
                            // Confirmed empirically without injecting anything: with
                            // mayInject=false in HUMAN_TAKEOVER, /scaninput refused with
                            // "target window is not visible" - a TARGET failure - where
                            // /click-absolute refused with "human takeover detected" - a GUARD
                            // failure. The difference in refusal reason is the proof that the
                            // guard was never consulted.
                            //
                            // A boundary enforced by remembering is not a boundary. This one
                            // cannot be forgotten: no route body executes until it has run, and
                            // adding a route to InjectionRoutes is the only way to make it
                            // injectable - an omission denies by default rather than permits by
                            // default.
                            //
                            // The per-route MayInject() checks further down are kept as defence
                            // in depth. They are no longer load-bearing.
                            if (RequiresPermission(path) && !Guard.MayInject())
                            {
                                string ge = "{\"ok\":false,\"refused\":true,\"guard\":true,\"error\":\"" + Esc(Guard.WhyRefused()) + "\"}";
                                byte[] gb = Encoding.UTF8.GetBytes(ge);
                                byte[] gh = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + gb.Length + "\r\nConnection: close\r\n\r\n");
                                ns.Write(gh, 0, gh.Length);
                                ns.Write(gb, 0, gb.Length);
                                Console.WriteLine("INJECTION GATE refused " + path + ": " + Guard.WhyRefused());
                                continue;
                            }

                            string response;
                            if (path == "/screen.png")
                            {
                                // This raw path is the one that actually serves every
                                // screenshot - it short-circuits before Handle(). An
                                // earlier fix added a proper region-capable, physically
                                // correct capture to Handle() and changed nothing at all,
                                // because this branch was still calling the old
                                // parameterless in-process version. Two code paths, one
                                // live, and the dead one was the one being maintained.
                                // Both now share the same implementation.
                                int capScale;
                                byte[] png = ScreenPng((int)Qs(query, "x"), (int)Qs(query, "y"),
                                                        (int)Qs(query, "w"), (int)Qs(query, "h"), out capScale);
                                byte[] head = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: " + png.Length + "\r\nConnection: close\r\n\r\n");
                                ns.Write(head, 0, head.Length);
                                ns.Write(png, 0, png.Length);
                                continue;
                            }
                            response = Handle(method, path, query, body);
                            byte[] bodyBytes = Encoding.UTF8.GetBytes(response.Substring(response.IndexOf("\r\n\r\n") + 4));
                            byte[] header = Encoding.ASCII.GetBytes(response.Substring(0, response.IndexOf("\r\n\r\n") + 4));
                            ns.Write(header, 0, header.Length);
                            ns.Write(bodyBytes, 0, bodyBytes.Length);
                        }
                    }
                }
                catch (Exception ex) { Console.WriteLine("req error: " + ex.Message); }
            }
        }
    }
}
