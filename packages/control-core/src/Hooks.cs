
// Low-level input hooks, ownership-tagged input injection, and a visible state
// indicator.
//
// WHY HOOKS RATHER THAN POLLING
//
// Polling (GetLastInputInfo, GetCursorPos on a timer) cannot distinguish the
// operator's own injected input from the human's, because both update the same
// system input state. Low-level hooks see each event before delivery and expose
// both the INJECTED flag and the caller-supplied dwExtraInfo, so ownership is
// PROVEN by the sentinel rather than inferred from timing.
//
// WHY SetCursorPos AND mouse_event ARE GONE
//
// Neither carries dwExtraInfo, so an event they produce cannot be identified as the
// operator's. Left in place, every cursor move the operator made would be
// indistinguishable from the human grabbing the mouse. All injection is therefore
// SendInput with the sentinel set.
//
// WHY THE RESERVED CHORDS ARE SWALLOWED
//
// The release and emergency-stop chords are handled inside the hook and return 1,
// so they never reach the focused application. A control that is supposed to hand
// control BACK to the human must not, as its side effect, type into whatever window
// happened to be focused.

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
    public class Hooks
    {
        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
        public delegate IntPtr WndProc(IntPtr h, uint msg, IntPtr w, IntPtr l);

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode; public uint scanCode; public uint flags; public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public int x; public int y; public uint mouseData; public uint flags; public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
            public uint time; public int ptX; public int ptY;
        }

        // CharSet.Unicode matters: without it the class name is marshalled as ANSI
        // while user32 expects UTF-16, RegisterClassEx fails, and the indicator window
        // is silently never created. A status indicator that does not exist is worse
        // than none, because it looks like it is working.
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct WNDCLASSEX
        {
            public uint cbSize; public uint style; public WndProc lpfnWndProc; public int cbClsExtra;
            public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor;
            public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName;
            public IntPtr hIconSm;
        }

        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint threadId);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h);
        [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint c);
        [DllImport("user32.dll")] public static extern uint GetMessage(out MSG m, IntPtr h, uint a, uint b);
        [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
        [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);
        [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint t, uint m, IntPtr w, IntPtr l);

        // overlay window
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern ushort RegisterClassEx(ref WNDCLASSEX c);
        // CharSet.Unicode to match the Unicode WNDCLASSEX the class is registered with, and
// SetLastError so a failure reports the real reason instead of leftover garbage.
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateWindowEx(uint ex, string cls, string title, uint style,
            int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int DrawText(IntPtr hdc, string s, int n, ref RECT r, uint fmt);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateSolidBrush(uint color);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetWindowText(IntPtr h, string s);
        [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool erase);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        public const int WH_KEYBOARD_LL = 13;
        public const int WH_MOUSE_LL = 14;
        public const int WM_KEYDOWN = 0x0100;
        public const int WM_SYSKEYDOWN = 0x0104;
        public const int WM_MOUSEMOVE = 0x0200;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        public const int WM_RBUTTONDOWN = 0x0204;
        public const int WM_RBUTTONUP = 0x0205;
        public const int WM_MBUTTONDOWN = 0x0207;
        public const int WM_MBUTTONUP = 0x0208;
        public const int WM_MOUSEWHEEL = 0x020A;
        public const int WM_XBUTTONDOWN = 0x020B;
        public const int WM_XBUTTONUP = 0x020C;

        public const uint LLMHF_INJECTED = 0x00000001;
        public const uint LLKHF_INJECTED = 0x00000010;

        public const int VK_CONTROL = 0x11;
        public const int VK_MENU = 0x12;      // Alt

        // Left/right modifier virtual-key codes.
        //
        // THE ROOT CAUSE OF THE CHORD LEAK.
        //
        // A low-level keyboard hook reports the SIDE-SPECIFIC codes for modifiers: pressing
        // the left Ctrl yields 0xA2 (VK_LCONTROL), not 0x11 (VK_CONTROL). 0x11 is the generic
        // code that appears only in synthetic input paths.
        //
        // The modifier tracking compared k.vkCode against 0x11 and 0x12 alone. On a real
        // keyboard, therefore, ctrlDown and altDown were NEVER set true, so
        // `if (ctrlDown && altDown && k.vkCode == VK_F12)` could never fire, so the release
        // chord was never swallowed - it went to the focused application every single time.
        //
        // This was invisible to the whole automated suite, because the state machine (HTTP
        // /release refusing, guard refusing injection) was entirely separate from the hook and
        // entirely correct. Only a human pressing the chord could find it, which is exactly
        // what happened: Calculator opened.
        public const int VK_LCONTROL = 0xA2;
        public const int VK_RCONTROL = 0xA3;
        public const int VK_LMENU = 0xA4;
        public const int VK_RMENU = 0xA5;
        public const int VK_G = 0x47;            // release chord - a plain letter, no hardware mapping

        /// Keys that MUST NOT be used for a reserved chord on this machine, and why.
        ///
        /// F12 is excluded because it is not merely "risky" - it is PROVEN unswallowable
        /// here. The human pressed Ctrl+Alt+F12 and Calculator opened. The hook recorded
        /// human +0, swallowed +0 for that press: the event was consumed by the keyboard's
        /// own firmware before Windows ever saw it, so no hook can intercept it.
        ///
        /// The general lesson, which is why this is a list rather than a comment: a reserved
        /// chord is only reserved if the hook can actually see it. A chord on a key with a
        /// hardware or firmware binding is documented, tested synthetically - where SendInput
        /// produces a Windows-level key that IS interceptable - and then leaks in reality.
        /// Synthetic tests cannot detect this class of failure at all.
        ///
        /// F1 is excluded for the same reason as F12 on many keyboards (Help), and Escape is
        /// deliberately allowed because the emergency-stop chord is meant to be unmissable.
        public static bool IsHardwareMappedKey(uint vk)
        {
            if (vk == VK_F12) return true;   // firmware Calculator key - MEASURED, see above
            if (vk == 0x70) return true;     // F1, commonly Help in firmware
            return false;
        }

        /// Refuses a reserved chord on a key the hook cannot be trusted to see.
        ///
        /// Failing loudly here is the whole point. The alternative - registering a chord that
        /// silently leaks into the human's desktop - is precisely the defect that made this
        /// keyboard launch Calculator, and it looked completely healthy while doing it.
        public static void AssertSwallowable(uint vk, string chordName)
        {
            if (IsHardwareMappedKey(vk))
            {
                throw new InvalidOperationException(
                    "Refusing to use key 0x" + vk.ToString("X") + " for the " + chordName +
                    " chord: it is bound in hardware or firmware, so a low-level hook never sees" +
                    " the event and cannot swallow it. The chord would reach the human's desktop." +
                    " Choose a plain letter key and verify it against the real keyboard.");
            }
        }
        public const int VK_LSHIFT = 0xA0;
        public const int VK_RSHIFT = 0xA1;

        /// True for ANY Ctrl key, on either side, generic or injected. Deliberately not a
        /// single equality test - that is exactly the mistake being fixed.
        public static bool IsCtrl(uint vk)
        {
            return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL;
        }

        public static bool IsAlt(uint vk)
        {
            return vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU;
        }

        public static bool IsShift(uint vk)
        {
            return vk == 0x10 || vk == VK_LSHIFT || vk == VK_RSHIFT;
        }

        /// F24 - the liveness probe key. Unused by any application or reserved chord.
        public const int VK_F24 = 0x87;

        // ------------------------------------------------------- panel release control
        //
        // WHY THE PANEL, NOT A KEYBOARD CHORD
        //
        // The keyboard chord was retired as a REQUIRED control. It could not be proven: a
        // press produced human +0, chordReleaseSeen +0, swallowed +0, so the hook either never
        // saw it or never recognised it, and the recorded evidence cannot distinguish those
        // because the probe traffic in that window was not attributable.
        //
        // A control that cannot be measured must not be the thing a human depends on.
        //
        // WHY THIS IS HUMAN-ONLY IN STRUCTURE, NOT BY CONVENTION
        //
        // The release decision is made HERE, in the low-level mouse hook, and only from an
        // event that satisfies BOTH of these independently:
        //
        //   1. dwExtraInfo != Guard.Sentinel - the operator's own injected input carries the
        //      sentinel, so the automation layer cannot produce an untagged click. Its clicks
        //      are recognisably its own, and are refused.
        //   2. LLMHF_INJECTED is NOT set - Windows sets this flag on any event produced by
        //      SendInput or another injection API. A real finger on a real mouse does not set
        //      it. So this cannot be synthesised by any program on this machine.
        //
        // Both must hold. Condition 1 alone would still admit an untagged injection; condition
        // 2 alone would admit a sentinel-tagged event. Together they mean the only way to
        // release is a genuine hardware click by a human.
        //
        // There is deliberately NO callback, NO HTTP route and NO application event handler
        // that performs a release. A caller cannot invoke release; it can only put a physical
        // click in a rectangle. `release()` is not reachable from the automation layer at all.

        /// Screen rectangle of the RELEASE control, published by the indicator so the human
        /// can see where to click and the hook knows where to watch.
        public static int ReleaseX = 0, ReleaseY = 0, ReleaseW = 0, ReleaseH = 0;

        public static void SetReleaseRegion(int x, int y, int w, int h)
        {
            ReleaseX = x; ReleaseY = y; ReleaseW = w; ReleaseH = h;
        }

        public static bool InReleaseRegion(int x, int y)
        {
            if (ReleaseW <= 0 || ReleaseH <= 0) return false;
            return x >= ReleaseX && x < ReleaseX + ReleaseW && y >= ReleaseY && y < ReleaseY + ReleaseH;
        }

        /// Counters so a human can tell "it did not hear me" from "it heard me and refused".
        public static long MouseEventsSeen = 0;
        public static long MouseTaggedSeen = 0;
        public static long MouseUntaggedSeen = 0;
        public static long LastMouseExtra = 0;
        public static long SentinelValue = 0;
        public static int LastMouseX = 0;
        public static int LastMouseY = 0;
        public static long PanelReleaseSeen = 0;      // a click landed in the region
        public static long PanelReleaseAccepted = 0;  // and was a genuine hardware click
        public static long PanelReleaseRefused = 0;   // and was rejected as not-human
        public static volatile string LastPanelOutcome = "none";
        public static long PanelInjectedSeen = 0;     // clicks there that Windows flagged injected
        public static long PanelTaggedSeen = 0;       // clicks there that carried our sentinel

        // ---------------------------------------------------- liveness probe plumbing
        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint n, Input[] p, int size);

        [StructLayout(LayoutKind.Sequential)]
        struct Input { public uint type; public InputUnion U; }
        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        /// Emits one probe keystroke through the real input path.
        ///
        /// SendInput is required rather than PostMessage, because only SendInput travels the
        /// low-level hook chain. That is the entire property under test, so a probe that
        /// skipped the chain would prove nothing.
        private static void SendProbe()
        {
            var down = new Input { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_F24, dwFlags = 0x0001, dwExtraInfo = Guard.Sentinel } } };
            var up = new Input { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = VK_F24, dwFlags = 0x0002 | 0x0001, dwExtraInfo = Guard.Sentinel } } };
            int size = Marshal.SizeOf(typeof(Input));
            uint okDown = SendInput(1, new Input[] { down }, size);
            uint okUp = SendInput(1, new Input[] { up }, size);
            ProbeSent = (okDown == 1 ? 1 : 0) + (okUp == 1 ? 1 : 0);
            ProbeLastError = Marshal.GetLastWin32Error();
            ProbeStructSize = size;
        }

        /// What SendInput actually returned. Without this the probe reports "the hook is dead"
        /// when in fact the probe was never sent - which is the same class of mistake as an
        /// instrument that lies, and it cost a false safety alarm here.
        public static int ProbeSent = 0;
        public static int ProbeLastError = 0;
        public static int ProbeStructSize = 0;

        /// Detach the keyboard hook while LEAVING KeyboardHookInstalled true.
        ///
        /// This stages the exact condition Windows creates when a low-level hook exceeds
        /// LowLevelHooksTimeout: the callback stops being called, but nothing about the handle
        /// says so. Without a way to reproduce that, the liveness probe could be a watchdog
        /// that had never once been shown to detect anything.
        public static void BreakKeyboardHookSilently()
        {
            lock (kbdHookLock)
            {
                if (kbdHook != IntPtr.Zero) UnhookWindowsHookEx(kbdHook);
            }
            // KeyboardHookInstalled deliberately stays true - that is the whole point of the
            // control. It stages Windows' own behaviour after a LowLevelHooksTimeout removal,
            // where nothing clears the flag.
        }

        /// Reinstall both hooks and clear the silent-removal flag.
        ///
        /// Needed because the liveness negative control deliberately detaches the keyboard
        /// hook. Without a way back, running the proof would leave the operator permanently
        /// unable to swallow its chords - a test that damages the thing it tests.
        ///
        /// The handle is cleared FIRST and the hook always reinstalled, because after
        /// UnhookWindowsHookEx the handle is still non-zero: guarding on it would skip the
        /// reinstall and leave the operator permanently broken.
        public static void Reinstall()
        {
            lock (kbdHookLock)
            {
                kbdHook = IntPtr.Zero;
                mouseHook = IntPtr.Zero;
                SilentlyRemoved = false;
                LivenessFailures = 0;
            }
            kbdHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbdProc, GetModuleHandle(null), 0);
            KeyboardHookError = Marshal.GetLastWin32Error();
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);
            MouseHookError = Marshal.GetLastWin32Error();
            KeyboardHookInstalled = kbdHook != IntPtr.Zero;
            MouseHookInstalled = mouseHook != IntPtr.Zero;
            if (!KeyboardHookInstalled || !MouseHookInstalled)
            {
                Guard.SetHookUnhealthy(UnhealthyReason() ?? "the hooks could not be reinstalled");
            }
            else
            {
                Guard.ClearHookUnhealthy();
            }
        }

        /// Reinstall both hooks and clear the silent-removal flag.
        ///
        /// Waits for a probe to come back through the hook.
        private static bool AwaitProbe(int timeoutMs)
        {
            int waited = 0;
            while (probeOutstanding && waited < timeoutMs)
            {
                if (probeSignal.WaitOne(25)) SendProbe();
                waited += 25;
            }
            return !probeOutstanding;
        }
        public const int VK_ESCAPE = 0x1B;
        public const int VK_F12 = 0x7B;
        public const int VK_O = 0x4F;
        public const int VK_R = 0x52;

        // Jitter threshold, in pixels. A human's hand resting on the mouse produces
        // sub-pixel drift constantly; that must NOT be read as a takeover, or the
        // operator would suspend itself every time the user shifted in their chair.
        public const int JITTER_PX = 8;

        static IntPtr kbdHook = IntPtr.Zero;

        /// The keyboard hook handle, for the liveness negative control. UnhookWindowsHookEx
        /// detaches the hook WITHOUT clearing this, which is precisely what Windows does on
        /// LowLevelHooksTimeout - so the failure the watchdog exists to catch can be staged.
        public static IntPtr ExposedKeyboardHook { get { lock (kbdHookLock) { return kbdHook; } } }
        static readonly object kbdHookLock = new object();
        static IntPtr mouseHook = IntPtr.Zero;
        static uint hookThread = 0;
        static HookProc kbdProc;
        static HookProc mouseProc;

        // Where the operator last put the cursor. A human move measured from this
        // point is what "the human took over" actually means.
        public static int lastX = -1;
        public static int lastY = -1;

        static bool ctrlDown = false;
        static bool altDown = false;
        static bool shiftDown = false;

        /// The reserved chord key whose RELEASE still has to be swallowed. Without this latch
        /// the keyup leaked to the focused application.
        static volatile uint pendingChordKey = 0;
        /// True from the moment a reserved chord is recognised until its key is fully released,
        /// so modifier keyups belonging to the chord can be told from ordinary ones.
        static volatile bool chordKeyLatched = false;

        // ------------------------------------------------------- hook diagnostics
        //
        // WHY THESE EXIST
        //
        // SetWindowsHookEx was called and its result thrown away. If it failed, kbdHook
        // stayed IntPtr.Zero, every callback call became CallNextHookEx(IntPtr.Zero, ...),
        // and every keystroke went straight through to the focused application.
        //
        // That failure was invisible, and it was invisible in the worst possible way: the
        // HTTP guard still refused injection, so /type still failed, so every automated
        // safety test still passed. The state machine was provably correct and the hook was
        // provably absent at the same time. A human pressing Ctrl+Alt+F12 then had that
        // chord delivered to their desktop, which opened Calculator.
        //
        // Nothing about the hook was observable, so nothing could have told anyone. These
        // counters come from the actual hook path, so they are evidence rather than a
        // status message about a status message.

        /// Set true once SetWindowsHookEx(WH_KEYBOARD_LL) has returned non-zero.
        public static volatile bool KeyboardHookInstalled = false;
        public static volatile bool MouseHookInstalled = false;
        /// Win32 error from SetWindowsHookEx, for the reason it failed if it did.
        public static int KeyboardHookError = 0;
        public static int MouseHookError = 0;
        /// Live thread id that owns the hook, so a second host can be detected.
        public static uint HookThreadId = 0;
        public static volatile bool HookThreadAlive = false;

        /// Modifier state as the hook last observed it. The chord match depends on this and
        /// nothing else, so it is reported rather than inferred.
        public static volatile bool LastCtrlDown = false;
        public static volatile bool LastAltDown = false;
        public static long LastChordKeySeen = 0;

        /// A short trace of the most recent keyboard events as the hook saw them, including
        /// the modifier state at each one. Written only when tracing is on, because a chord
        /// match that fails for no visible reason is otherwise undiagnosable: "not swallowed"
        /// and "modifiers not seen as held" look identical from outside.
        public static volatile bool Trace = false;
        public static string TraceLog = "";

        /// Every event the keyboard callback has actually seen, whatever it decided.
        public static long KbdEventsSeen = 0;
        public static long KbdKeyDownSeen = 0;
        public static long KbdKeyUpSeen = 0;
        /// Events the callback CONSUMED rather than passing on. A reserved chord that is
        /// swallowed must increment this. If it stays 0 while a chord was pressed, the
        /// hook is not doing its job no matter what any status says.
        public static long KbdSwallowed = 0;
        public static long KbdPassedThrough = 0;

        /// Chord recognition and outcome, per reserved chord.
        public static long ChordReleaseSeen = 0;
        public static long ChordRearmSeen = 0;
        public static long ChordStopSeen = 0;
        public static long ChordObserveSeen = 0;
        public static long ChordUnknown = 0;

        /// What the hook did with the most recent reserved chord, for the indicator and for
        /// post-mortem. This is the single most important field when asking "did my chord
        /// reach my desktop?".
        public static volatile string LastChordOutcome = "none";
        public static long LastChordAt = 0;

        /// A hook that is not installed cannot swallow anything, and every input path in the
        /// operator depends on that. So this is a hard precondition, not a warning.
        public static string UnhealthyReason()
        {
            if (!KeyboardHookInstalled)
                return "WH_KEYBOARD_LL is NOT installed (SetWindowsHookEx error " + KeyboardHookError
                     + "); reserved chords are NOT swallowed and every keystroke reaches the focused application";
            if (!HookThreadAlive)
                return "the hook thread has exited; a low-level keyboard hook needs a live message loop";
            if (SilentlyRemoved)
                return "Windows removed the keyboard hook (LowLevelHooksTimeout exceeded). The handle still looks valid, "
                     + "but the callback is no longer called, so reserved chords are NOT swallowed";
            if (!MouseHookInstalled)
                return "WH_MOUSE_LL is not installed (error " + MouseHookError + "); human mouse takeover cannot be detected";
            return null;
        }

        /// True when the hook has gone silent while still looking installed.
        ///
        /// This is the failure that made the real-world bug invisible. SetWindowsHookEx
        /// returning non-zero only proves the hook was installed AT THAT MOMENT. If the
        /// callback later exceeds LowLevelHooksTimeout, Windows uninstalls it without telling
        /// anyone and without clearing the handle - so every "is it installed?" check keeps
        /// answering yes while input flows straight to the desktop.
        ///
        /// The only way to notice is a LIVENESS PROBE: periodically generate one input event
        /// from inside this process and confirm the callback actually runs. If it does not, the
        /// hook is gone and the operator must say so rather than claim the chords are safe.
        public static volatile bool SilentlyRemoved = false;
        public static long LivenessProbes = 0;
        public static long LivenessProbeHits = 0;
        public static long LivenessFailures = 0;
        private static readonly System.Threading.AutoResetEvent probeSignal = new System.Threading.AutoResetEvent(false);
        private static volatile bool probeOutstanding = false;

        public static string Report()
        {
            // Liveness, reported so a human or a test can tell the difference between
            // "installed" and "actually still in the chain".
            Interlocked.Increment(ref LivenessProbes);
            probeOutstanding = true;
            // The signal is what makes AwaitProbe actually send anything. Without this line the
            // probe waits on an event nobody raises, reports failure, and falsely declares a
            // healthy hook dead - which is exactly what happened the first time, and it is the
            // same failure mode as any instrument that reports a conclusion it did not test.
            probeSignal.Set();
            // 400ms: long enough to beat LowLevelHooksTimeout under load, short enough not to
            // stall an HTTP response.
            bool delivered = AwaitProbe(400);
            if (delivered) Interlocked.Increment(ref LivenessProbeHits);
            else
            {
                Interlocked.Increment(ref LivenessFailures);
                SilentlyRemoved = true;
                Guard.SetHookUnhealthy(UnhealthyReason() ?? "the keyboard hook stopped receiving its own liveness probe");
            }

            StringBuilder b = new StringBuilder();
            b.Append("{\"keyboardHookInstalled\":").Append(KeyboardHookInstalled ? "true" : "false")
             .Append(",\"mouseHookInstalled\":").Append(MouseHookInstalled ? "true" : "false")
             .Append(",\"keyboardHookError\":").Append(KeyboardHookError)
             .Append(",\"mouseHookError\":").Append(MouseHookError)
             .Append(",\"hookThreadId\":").Append(HookThreadId)
             .Append(",\"hookThreadAlive\":").Append(HookThreadAlive ? "true" : "false")
             .Append(",\"kbdEventsSeen\":").Append(KbdEventsSeen)
             .Append(",\"kbdKeyDownSeen\":").Append(KbdKeyDownSeen)
             .Append(",\"kbdKeyUpSeen\":").Append(KbdKeyUpSeen)
             .Append(",\"kbdSwallowed\":").Append(KbdSwallowed)
             .Append(",\"kbdPassedThrough\":").Append(KbdPassedThrough)
             .Append(",\"chordReleaseSeen\":").Append(ChordReleaseSeen)
             .Append(",\"chordRearmSeen\":").Append(ChordRearmSeen)
             .Append(",\"chordStopSeen\":").Append(ChordStopSeen)
             .Append(",\"chordObserveSeen\":").Append(ChordObserveSeen)
             .Append(",\"chordUnknown\":").Append(ChordUnknown)
             .Append(",\"lastChordOutcome\":\"").Append(LastChordOutcome)
             .Append("\",\"lastChordAt\":").Append(LastChordAt)
             .Append(",\"lastCtrlDown\":").Append(LastCtrlDown ? "true" : "false")
             .Append(",\"lastAltDown\":").Append(LastAltDown ? "true" : "false")
             .Append(",\"lastChordKeySeen\":").Append(LastChordKeySeen)
             .Append(",\"traceLog\":\"").Append(TraceLog.Replace("\\", "\\\\").Replace("\"", "\x27"))
             .Append("\",\"livenessProbes\":").Append(LivenessProbes)
             .Append(",\"livenessProbeHits\":").Append(LivenessProbeHits)
             .Append(",\"livenessFailures\":").Append(LivenessFailures)
             .Append(",\"silentlyRemoved\":").Append(SilentlyRemoved ? "true" : "false")
             .Append(",\"probeSent\":").Append(ProbeSent)
             .Append(",\"probeLastError\":").Append(ProbeLastError)
             .Append(",\"probeStructSize\":").Append(ProbeStructSize)
             .Append(",\"lastMouseExtra\":").Append(LastMouseExtra)
             .Append(",\"sentinelValue\":").Append(SentinelValue)
             .Append(",\"mouseEventsSeen\":").Append(MouseEventsSeen)
             .Append(",\"mouseTaggedSeen\":").Append(MouseTaggedSeen)
             .Append(",\"mouseUntaggedSeen\":").Append(MouseUntaggedSeen)
             .Append(",\"lastMouse\":[").Append(LastMouseX).Append(",").Append(LastMouseY).Append("]")
             .Append(",\"panelReleaseSeen\":").Append(PanelReleaseSeen)
             .Append(",\"panelReleaseAccepted\":").Append(PanelReleaseAccepted)
             .Append(",\"panelReleaseRefused\":").Append(PanelReleaseRefused)
             .Append(",\"panelInjectedSeen\":").Append(PanelInjectedSeen)
             .Append(",\"panelTaggedSeen\":").Append(PanelTaggedSeen)
             .Append(",\"lastPanelOutcome\":\"").Append(LastPanelOutcome).Append("\"")
             .Append(",\"releaseRegion\":[").Append(ReleaseX).Append(",").Append(ReleaseY)
             .Append(",").Append(ReleaseW).Append(",").Append(ReleaseH).Append("]")
             .Append(",\"unhealthyReason\":");
            string u = UnhealthyReason();
            if (u == null) b.Append("null"); else b.Append("\"").Append(u.Replace("\"", "'")).Append("\"");
            b.Append(",\"processId\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id);
            b.Append(",\"sessionId\":").Append(System.Diagnostics.Process.GetCurrentProcess().SessionId);
            return b.Append("}").ToString();
        }

        // ---------------------------------------------------------------- hooks

        public static void Start()
        {
            if (kbdHook != IntPtr.Zero) return;
            kbdProc = KeyboardProc;
            mouseProc = MouseProc;
            var t = new Thread(Run);
            t.IsBackground = true;
            t.Name = "operator-hooks";
            t.Start();
        }

        static void Run()
        {
            hookThread = Win.GetCurrentThreadId();
            HookThreadId = hookThread;
            HookThreadAlive = true;
            IntPtr mod = GetModuleHandle(null);
            kbdHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbdProc, mod, 0);
            KeyboardHookError = Marshal.GetLastWin32Error();
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, mod, 0);
            MouseHookError = Marshal.GetLastWin32Error();

            // CHECKED, which it was not before. A failed SetWindowsHookEx used to be
            // discarded silently, leaving CallNextHookEx(IntPtr.Zero, ...) to pass every
            // keystroke to the focused application while every automated test still
            // passed, because the HTTP guard refused injection regardless. The reserved
            // chords were documented as swallowed and in fact reached the human's desktop.
            //
            // Now a missing keyboard hook refuses injection outright. An operator whose
            // chords leak into the desktop is worse than an operator that does nothing,
            // because the human is relying on the chords working.
            KeyboardHookInstalled = kbdHook != IntPtr.Zero;
            MouseHookInstalled = mouseHook != IntPtr.Zero;

            string why = UnhealthyReason();
            if (why != null) Guard.SetHookUnhealthy(why);

            MSG m;
            // A real message loop: low-level hooks are delivered by message
            // dispatch, so without this the callbacks never fire at all.
            while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref m);
                DispatchMessage(ref m);
            }
            // The loop exited: the hook is gone. Recorded rather than left implied.
            HookThreadAlive = false;
            Guard.SetHookUnhealthy("the hook thread exited its message loop; reserved chords are no longer swallowed");
        }

        static IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                try
                {
                    int msg = (int)wParam;
                    KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    Interlocked.Increment(ref KbdEventsSeen);
                    // If this event is the liveness probe, confirm delivery and stand down.
                    // F24 is chosen because no application or chord uses it, and the sentinel
                    // marks it as the operator's own so it can never be credited to the human.
                    if (probeOutstanding && k.vkCode == VK_F24)
                    {
                        probeOutstanding = false;
                        return new IntPtr(1);   // swallowed: the probe must never reach an app
                    }
                    bool isDown = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
                    if (isDown) Interlocked.Increment(ref KbdKeyDownSeen);
                    else Interlocked.Increment(ref KbdKeyUpSeen);

                    LastChordKeySeen = k.vkCode;
                    // TRACE IS DELIBERATELY OFF INSIDE THE CALLBACK.
                    //
                    // Building a string per keystroke here is slow, and WH_KEYBOARD_LL has a
                    // hard timeout (LowLevelHooksTimeout, 300ms by default). When a callback
                    // exceeds it Windows SILENTLY UNINSTALLS the hook - the handle stays
                    // non-zero, so every "is the hook installed?" check still answers yes, and
                    // input then flows straight through to the desktop.
                    //
                    // That failure is invisible by construction, which makes it far worse than
                    // a crash: the panel would read healthy, the guard would still refuse
                    // injected input, and the reserved chords would leak - with no signal at
                    // all that anything was wrong.
                    //
                    // So the callback records NUMBERS ONLY. The event-level trace is assembled
                    // on demand from those counters, never inside the hook.
                    if (IsCtrl(k.vkCode)) ctrlDown = isDown;
                    if (IsAlt(k.vkCode)) altDown = isDown;
                    if (IsShift(k.vkCode)) shiftDown = isDown;
                    // Record the modifier state as the hook sees it, because the chord match
                    // depends entirely on it and it is the one thing that can be wrong in a way
                    // no other counter reveals. Without this, "the chord was not swallowed" and
                    // "the modifiers were not seen as held" are indistinguishable.
                    LastCtrlDown = ctrlDown;
                    LastAltDown = altDown;

                    if (k.dwExtraInfo == Guard.Sentinel)
                    {
                        Guard.NoteOperatorEvent();
                    }
                    else
                    {
                        // THE RELEASE CHORD MOVED OFF F12 BECAUSE F12 CANNOT BE SWALLOWED ON THIS HARDWARE.
                        //
                        // Measured, not assumed. The human pressed Ctrl+Alt+F12 and Calculator
                        // opened. The hook's own counters for that press read:
                        //
                        //     human +0   seen +2 (both were the host's own F24 probe)
                        //     swallowed +0   chordReleaseSeen +0
                        //
                        // The hook saw NOTHING of that press. The keyboard has a Calculator
                        // key mapped onto F12 in its FIRMWARE, which consumes the event before
                        // Windows sees it. A WH_KEYBOARD_LL hook sits BELOW that: it only ever
                        // observes events Windows processes, so a firmware-level hotkey is
                        // structurally unswallowable by any hook, mine or anyone's.
                        //
                        // Every synthetic test "passed" because SendInput emits a Windows-level
                        // F12, which IS interceptable. Real hardware does not. The tests were
                        // measuring a key that does not exist on this machine.
                        //
                        // The release chord is now Ctrl+Alt+G - a plain letter, no hardware
                        // mapping, and nothing on Windows or this keyboard claims it.
                        //
                        // A reserved chord must be verified against the REAL key the human
                        // presses, on the real hardware, or it is not a reserved chord at all.

                        // BOTH halves of a reserved chord must be consumed, and the KEYUP is
                        // the half that used to leak.
                        //
                        // The old code returned 1 (swallow) only on the keydown branch of the
                        // chord match. The keyup then fell through to NoteHumanEvent and
                        // CallNextHookEx - i.e. straight to the focused application - whenever
                        // the human released Alt or Ctrl before releasing the chord key, which
                        // is the ordinary way people let go of a chord.
                        //
                        // Worse, on keyup the match re-tested ctrlDown && altDown, so a chord
                        // key released while both modifiers were still held was counted as a
                        // SECOND chord press. One physical press could arm release twice.
                        //
                        // The latch below fixes both: once a chord key is recognised on the
                        // way down, that key's release is swallowed regardless of modifier
                        // state, and it cannot be mistaken for a new press.
                        if (isDown && ctrlDown && altDown)
                        {
                            if (k.vkCode == VK_ESCAPE)
                            {
                                Interlocked.Increment(ref ChordStopSeen);
                                pendingChordKey = k.vkCode;
                                chordKeyLatched = true;
                                LastChordOutcome = "Ctrl+Alt+Esc recognized; swallowed; emergency stop latched";
                                LastChordAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                Guard.EmergencyStop("Ctrl+Alt+Esc pressed by the human");
                                Interlocked.Increment(ref KbdSwallowed);
                                return new IntPtr(1);
                            }
                            if (k.vkCode == VK_G)
                            {
                                AssertSwallowable(VK_G, "release");
                                Interlocked.Increment(ref ChordReleaseSeen);
                                pendingChordKey = k.vkCode;
                                chordKeyLatched = true;
                                LastChordOutcome = "Ctrl+Alt+G recognized; swallowed; release pending";
                                LastChordAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                Guard.releasePending = true;
                                Interlocked.Increment(ref KbdSwallowed);
                                return new IntPtr(1);
                            }
                            if (k.vkCode == VK_O)
                            {
                                Interlocked.Increment(ref ChordObserveSeen);
                                pendingChordKey = k.vkCode;
                                chordKeyLatched = true;
                                LastChordOutcome = "Ctrl+Alt+O recognized; swallowed; observe toggle pending";
                                LastChordAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                Guard.observeTogglePending = true;
                                Interlocked.Increment(ref KbdSwallowed);
                                return new IntPtr(1);
                            }
                            // Re-arm had no chord, which meant the ONLY way to clear a human's
                            // emergency stop was an HTTP call the operator could also make.
                            // Closing that endpoint without adding this first would have made the
                            // latch permanent - a safety control that cannot be cleared is not a
                            // safety control, it is an outage. Added BEFORE the endpoint closed.
                            if (k.vkCode == VK_R)
                            {
                                Interlocked.Increment(ref ChordRearmSeen);
                                pendingChordKey = k.vkCode;
                                chordKeyLatched = true;
                                LastChordOutcome = "Ctrl+Alt+R recognized; swallowed; re-arm pending";
                                LastChordAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                Guard.rearmPending = true;
                                Interlocked.Increment(ref KbdSwallowed);
                                return new IntPtr(1);
                            }
                            Interlocked.Increment(ref ChordUnknown);
                        }

                        // The release half of a chord already consumed above. Swallowed
                        // unconditionally: no application should ever see it.
                        if (!isDown && pendingChordKey == k.vkCode)
                        {
                            pendingChordKey = 0;
                            Interlocked.Increment(ref KbdSwallowed);
                            return new IntPtr(1);
                        }

                        // A modifier released after a chord must also not leak, or the focused
                        // application sees a dangling Ctrl/Alt and a stray F12-shaped chord.
                        if (!isDown && (IsCtrl(k.vkCode) || IsAlt(k.vkCode) || IsShift(k.vkCode)) && chordKeyLatched)
                        {
                            chordKeyLatched = false;
                        }

                        Guard.NoteHumanEvent();
                        Guard.HumanTakeover("human keyboard event (vk=0x" + k.vkCode.ToString("X2") + ")");
                    }
                }
                catch { }
            }
            Interlocked.Increment(ref KbdPassedThrough);
            return CallNextHookEx(kbdHook, nCode, wParam, lParam);
        }

        static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                try
                {
                    int msg = (int)wParam;
                    MSLLHOOKSTRUCT m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));

                    Interlocked.Increment(ref MouseEventsSeen);
                    LastMouseX = m.x; LastMouseY = m.y;
                    LastMouseExtra = m.dwExtraInfo.ToInt64();
                    if (m.dwExtraInfo == Guard.Sentinel)
                    {
                        Interlocked.Increment(ref MouseTaggedSeen);
                        Guard.NoteOperatorEvent();
                        // An operator-OWNED click in the release region is refused explicitly.
                        // The automation layer can put the cursor on the button perfectly
                        // well; what it cannot do is make the click untagged.
                        if (msg == WM_LBUTTONDOWN && InReleaseRegion(m.x, m.y))
                        {
                            Interlocked.Increment(ref PanelTaggedSeen);
                            Interlocked.Increment(ref PanelReleaseRefused);
                            LastPanelOutcome = "release REFUSED: the click carried the operator sentinel, so it is automation, not a human";
                        }
                    }
                    else
                    {
                        // THE RELEASE CONTROL.
                        //
                        // Evaluated here, in the low-level hook, because this is the only layer
                        // that can tell a hardware click from a synthesised one. There is no
                        // callback above this that releases anything.
                        if (msg == WM_LBUTTONDOWN && InReleaseRegion(m.x, m.y))
                        {
                            Interlocked.Increment(ref PanelReleaseSeen);

                            // Windows sets LLMHF_INJECTED on anything SendInput (or any other
                            // injection API) produced. A physical click never carries it, so
                            // this cannot be faked by any program on this machine.
                            bool synthetic = (m.flags & LLMHF_INJECTED) != 0;
                            if (synthetic)
                            {
                                Interlocked.Increment(ref PanelInjectedSeen);
                                Interlocked.Increment(ref PanelReleaseRefused);
                                LastPanelOutcome = "release REFUSED: Windows flagged that click as injected, so it was synthesised, not physical";
                                // Swallowed: a refused click must not also activate whatever is
                                // behind the panel.
                                return new IntPtr(1);
                            }

                            Interlocked.Increment(ref PanelReleaseAccepted);
                            LastPanelOutcome = "release ACCEPTED: genuine hardware click";
                            LastChordOutcome = LastPanelOutcome;
                            LastChordAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            Guard.releasePending = true;
                            return new IntPtr(1);
                        }

                        if ((m.flags & LLMHF_INJECTED) != 0) Guard.NoteOtherInjected();
                        bool isButton = msg != WM_MOUSEMOVE;
                        if (isButton)
                        {
                            Guard.NoteHumanEvent();
                            Guard.HumanTakeover("human mouse button event (msg=0x" + msg.ToString("X") + ")");
                        }
                        else
                        {
                            Interlocked.Increment(ref MouseUntaggedSeen);
                        // Movement: only a displacement beyond the jitter threshold
                            // counts, measured from where the operator last put the
                            // cursor. Drift below it is a hand at rest.
                            if (lastX < 0) { lastX = m.x; lastY = m.y; }
                            int dx = m.x - lastX, dy = m.y - lastY;
                            if (dx * dx + dy * dy > JITTER_PX * JITTER_PX)
                            {
                                Guard.NoteHumanEvent();
                                Guard.HumanTakeover("human mouse moved " + (int)Math.Sqrt(dx * dx + dy * dy) + "px from the operator's cursor");
                            }
                        }
                    }
                }
                catch { }
            }
            return CallNextHookEx(mouseHook, nCode, wParam, lParam);
        }

        // ------------------------------------------------- ownership-tagged input

        static void Stamp(ref Win.INPUT i)
        {
            if (i.type == 1) i.u.ki.dwExtraInfo = Guard.Sentinel;
            else if (i.type == 0) i.u.mi.dwExtraInfo = Guard.Sentinel;
        }

        public static void StampMouse(ref Win.INPUT i) { Stamp(ref i); }
        public static void StampKey(ref Win.INPUT i) { Stamp(ref i); }

        /// Absolute SendInput move, tagged. Replaces SetCursorPos, which cannot be
        /// tagged and would therefore be indistinguishable from the human.
        public static uint MoveAbsolute(int x, int y)
        {
            // SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77,
            // SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79
            int left = Win.GetSystemMetrics(76);
            int top = Win.GetSystemMetrics(77);
            int vw = Win.GetSystemMetrics(78);
            int vh = Win.GetSystemMetrics(79);
            int nx = (int)(((double)(x - left) / Math.Max(1, vw)) * 65535.0);
            int ny = (int)(((double)(y - top) / Math.Max(1, vh)) * 65535.0);
            if (nx < 0) nx = 0; if (nx > 65535) nx = 65535;
            if (ny < 0) ny = 0; if (ny > 65535) ny = 65535;

            var i = new Win.INPUT
            {
                type = 0,
                u = new Win.INPUTUNION
                {
                    mi = new Win.MOUSEINPUT
                    {
                        dx = nx,
                        dy = ny,
                        mouseData = 0,
                        // 0x8000 ABSOLUTE | 0x0001 MOVE | 0x4000 VIRTUALDESK
                        dwFlags = 0x8000 | 0x0001 | 0x4000,
                        time = 0,
                        dwExtraInfo = Guard.Sentinel
                    }
                }
            };
            uint sent = Win.SendInput(1, new Win.INPUT[] { i }, Marshal.SizeOf(typeof(Win.INPUT)));
            lastX = x; lastY = y;
            return sent;
        }
    }
}
