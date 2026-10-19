// ===========================================================================================
// LAUNCH - start a named Windows application.
//
// WHY THIS EXISTS
//
// The mission stack could type, click and read, but it could not OPEN anything. Every goal
// that begins "open X" was unplannable, which meant the most ordinary task a person would
// ask - open Notepad, write this, save it - could not be expressed at all. This closes that
// gap with the smallest thing that can: a named launcher, not a command runner.
//
// WHY IT IS AN ALLOWLIST AND NOT A SHELL
//
// A route that accepts an arbitrary command line and runs it is a remote-code-execution
// endpoint that happens to be local. The operator already has a read-only `terminal`
// capability with its own allowlist precisely so that machine access is enumerated rather
// than open-ended. Launching must not be the hole in that wall: only the applications
// listed below can be started, and nothing else is reachable, however it is phrased.
// An unknown name is REFUSED with the list of known names - a refusal that explains itself
// is recoverable; one that just says "no" is a dead end.
//
// WHY IT WAITS FOR THE WINDOW, AND WHY IT DOES NOT MATCH ON THE LAUNCHED PROCESS ID
//
// Returning as soon as Process.Start returns would report success for a program that has
// not drawn a window yet, and every caller would then try to type into a handle that does
// not exist.
//
// The obvious implementation - look for a window owned by the pid Process.Start gave back -
// was tried first and CANNOT work for a large class of Windows apps. Several, Notepad among
// them, are Store apps whose .exe is only a stub: it hands activation to the app model and
// exits, so the process ID returned belongs to a short-lived launcher that never owns a
// window, while the window that actually appears belongs to a process that was already
// running. Observed directly on this machine: Process.Start returned a pid with no window
// and no title, and the Notepad window that appeared belonged to a different pid entirely.
// Waiting on that pid forever is a fifteen-second timeout and a false failure, every time.
//
// So the window is found the way a person finds it: whatever window is NEW. The set of
// handles is snapshotted before the launch, and after it the loop waits for a visible,
// titled window whose handle was not in that snapshot. This matches single-instance apps,
// Store-app hand-off, and ordinary exes equally, and it does not guess from a title.
//
// It prefers a window owned by the launched pid when one appears, purely so the common case
// returns as soon as it is genuinely ready rather than at the first unrelated new window.
//
// It gives up and reports failure after the timeout rather than waiting forever: a launch
// that never produced a window is a real failure and must surface as one.
//
// GUARDING
//
// Launching a program changes the machine, so it sits behind Guard.MayInject() in the route
// (OperatorHost.cs) exactly like every other mutating endpoint. This class does no guarding
// of its own and must never be reachable from a path that skipped it.
// ===========================================================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace PortAiOperator
{
    public sealed class LaunchResult
    {
        public bool Ok;
        public string Error = "";
        public string App = "";
        /// The document the application was asked to open, if any. Reported back so the caller
        /// can confirm which file the window it now holds actually is.
        public string Path = "";
        /// True when the window belonged to an ALREADY-RUNNING instance rather than a new one.
        /// Reported so the caller can tell "I started this" from "this was already open", which
        /// are different situations with different consequences for what happens next.
        public bool Adopted;
        public long Hwnd;
        public int Pid;
        public string Title = "";
    }

    public static class Launch
    {
        /// The only applications that can be started. Key = the name AIOS and the user say.
        /// A trailing "|arg" is appended verbatim to the executable when one is supplied, so the
        /// argument is a FIXED part of the allowlist and not user text. The user chooses WHICH
        /// document to open, never what is executed with it.
        static readonly Dictionary<string, string> Allow = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "notepad",    "notepad.exe" },
            { "calculator", "calc.exe" },
            { "paint",      "mspaint.exe" },
            { "explorer",   "explorer.exe" },
            { "wordpad",    "write.exe" },
            { "cmd",        "cmd.exe" },
            { "powershell", "powershell.exe" },
            // Browsers. Not on PATH, so these hold a CANDIDATE list and are resolved to a real
            // path at launch time - see ResolveBrowser. A browser that could not be found is a
            // refusal with a reason, never a silent success.
            { "browser",    BrowserCandidates },
            { "edge",       BrowserCandidates },
            { "chrome",     BrowserCandidates },
        };

        /// Where a Chromium browser may be installed, best first.
        ///
        /// A browser is the one entry on this list that is not guaranteed to exist, and the
        /// honest failure is "no browser was found on this machine" rather than an exception from
        /// Process.Start naming a path the user has never seen.
        const string BrowserCandidates =
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe|"
          + "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe|"
          + "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe|"
          + "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";

        /// The first browser candidate that actually exists, or null.
        static string ResolveBrowser(string which)
        {
            string[] order;
            if (string.Equals(which, "chrome", StringComparison.OrdinalIgnoreCase))
            {
                // Asking for Chrome specifically must not silently hand back Edge.
                order = new[]
                {
                    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                };
            }
            else if (string.Equals(which, "edge", StringComparison.OrdinalIgnoreCase))
            {
                order = new[]
                {
                    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
                };
            }
            else
            {
                order = BrowserCandidates.Split('|');
            }
            foreach (var c in order)
            {
                if (System.IO.File.Exists(c)) return c;
            }
            return null;
        }

        /// True if this is a URL the operator is willing to hand a browser.
        ///
        /// A URL is caller-supplied text, and the rule elsewhere on this class is that
        /// caller text never becomes part of the command line unexamined.
        ///
        /// The threat is ARGUMENT INJECTION into CreateProcess - and CreateProcess is not a shell.
        /// `&`, `|`, `;` and `<` only chain commands in a shell; with no shell in the path they
        /// arrive at the browser as ordinary characters inside a single argument. So the only
        /// characters that actually carry structure are the ones CreateProcess itself treats as
        /// structure: WHITESPACE, which starts a new argument, and the QUOTE and BACKSLASH that
        /// change how the remainder is parsed.
        ///
        /// Ampersand is therefore ALLOWED. That is a correction, not a convenience: it is the
        /// separator in `?a=1&b=2`, so a first draft that refused it broke ordinary searches
        /// carrying two or more parameters - which is most of them - while protecting against a
        /// shell that does not exist on this path. A rule that refuses the common case is not a
        /// strict rule, it is a broken one, and the test suite is what caught it.
        ///
        /// No shell metacharacter beyond whitespace is refused here, deliberately: they are inert
        /// on this path, and refusing them would have meant guessing about a shell that is absent.
        public static bool MayOpenUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return false;
            if (url.Length > 2048) return false;
            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return false;
            foreach (var c in url)
            {
                if (c == '"' || c == '\\') return false;
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') return false;
            }
            return true;
        }

        /// Applications that may be asked to open a specific file.
        ///
        /// Separated from Allow on purpose. "Start notepad" and "start notepad with THIS path" are
        /// different capabilities, and only the second one carries a value a caller chose. Keeping
        /// them apart means the path-accepting surface can be reasoned about on its own instead of
        /// being a flag on an entry that is otherwise inert.
        static readonly Dictionary<string, string> WithFile = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "notepad",    "notepad.exe" },
            { "paint",      "mspaint.exe" },
            { "wordpad",    "write.exe" },
        };

        /// Files that may NOT be opened this way, whatever the path.
        ///
        /// An allowlist of openable folders would be better, but the HOST cannot enforce one: it
        /// does not know which folders the mission layer considers readable, and duplicating that
        /// rule here would give two places to get it wrong. So the check lives in the capability
        /// that owns the rule, and this host-level list is the hard backstop for the things that
        /// must never be opened no matter who asks - executables and libraries, which are what
        /// turns "open a document" into "run this".
        static readonly string[] NeverOpen = { ".exe", ".dll", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".scr", ".com", ".msi", ".sys" };

        public static bool MayOpenFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return false;
            string ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
            // Array.IndexOf, not Array.Contains: Contains needs System.Linq, and adding a using for
            // one membership test on a nine-element array would be the larger change.
            return Array.IndexOf(NeverOpen, ext) < 0;
        }

        public static string KnownNames()
        {
            var names = new List<string>(Allow.Keys);
            names.Sort(StringComparer.Ordinal);
            return string.Join(", ", names.ToArray());
        }

        /// True if this name may be launched at all. Checked BEFORE any path is built.
        public static bool IsAllowed(string name)
        {
            return name != null && Allow.ContainsKey(name.Trim());
        }

        public static LaunchResult Run(string name, int timeoutMs, string path)
        {
            return Run(name, timeoutMs, path, null);
        }

        public static LaunchResult Run(string name, int timeoutMs, string path, string url)
        {
            var r = new LaunchResult { App = (name ?? "").Trim(), Path = path };
            bool wantFile = !string.IsNullOrWhiteSpace(path);
            bool wantUrl = !string.IsNullOrWhiteSpace(url);

            // A URL is a browser's argument, and a document is a file's. Neither is accepted by
            // an application that has no business taking one, so the two are checked separately
            // rather than being allowed to fall through into each other.
            bool isBrowser = r.App.Equals("browser", StringComparison.OrdinalIgnoreCase)
                || r.App.Equals("edge", StringComparison.OrdinalIgnoreCase)
                || r.App.Equals("chrome", StringComparison.OrdinalIgnoreCase);

            if (wantUrl && !isBrowser)
            {
                r.Error = "\"" + r.App + "\" cannot be given a web address. Applications that can: browser, edge, chrome";
                return r;
            }
            if (wantFile && isBrowser)
            {
                r.Error = "a browser is not asked to open a local document; pass the file to the application that edits it";
                return r;
            }
            if (wantFile && !WithFile.ContainsKey(r.App))
            {
                r.Error = wantFile
                    ? "\"" + r.App + "\" cannot be told to open a specific document. Applications that can: "
                        + string.Join(", ", new List<string>(WithFile.Keys).ToArray())
                    : "\"" + r.App + "\" is not an application this operator may launch. Known: " + KnownNames();
                return r;
            }
            if (!IsAllowed(r.App))
            {
                r.Error = "\"" + r.App + "\" is not an application this operator may launch. Known: " + KnownNames();
                return r;
            }
            if (wantUrl && !MayOpenUrl(url))
            {
                r.Error = "refusing to open \"" + url + "\": a web address must be a plain http or https URL "
                    + "with no spaces, quotes or shell characters";
                return r;
            }
            if (wantFile && !MayOpenFile(path))
            {
                r.Error = "refusing to open \"" + path + "\": " + System.IO.Path.GetExtension(path)
                    + " is a program or library, and opening a document must never be a way to run one";
                return r;
            }

            // Snapshot BEFORE the launch. Anything already on screen cannot be this launch's
            // result, and this is what makes the Store-app hand-off case work.
            var before = VisibleHandles();

            string exe;
            if (isBrowser)
            {
                exe = ResolveBrowser(r.App);
                if (exe == null)
                {
                    r.Error = "no " + r.App + " installation was found in the standard locations on this machine";
                    return r;
                }
            }
            else
            {
                exe = Allow[r.App.Trim()];
            }
            // ProcessStartInfo.Arguments is set from a FIXED allowlist entry ("|%1") with the path
            // substituted, never from caller text, so a path containing a quote or a space cannot
            // turn into an extra argument. The URL is the one caller-supplied argument, and
            // MayOpenUrl has already rejected every character that could split it.
            var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
            if (wantFile) psi.Arguments = "\"" + path + "\"";
            if (wantUrl) psi.Arguments = "\"" + url + "\"";
            // A browser opened without a profile of its own attaches to the user's real session,
            // which is not what a mission should touch. --guest keeps the launch visible and
            // separate without reading or writing the user's history.
            if (isBrowser && psi.Arguments.Length == 0) psi.Arguments = "--guest";
            Process p = null;
            try
            {
                p = Process.Start(psi);
            }
            catch (Exception e)
            {
                r.Error = "could not start " + exe + ": " + e.Message;
                return r;
            }
            if (p == null)
            {
                r.Error = "the operating system did not start " + exe;
                return r;
            }

            // Wait for a window that is NEW. 50ms between polls is a real trade: the loop is
            // idle while waiting, and polling faster only burns CPU to observe the same
            // unchanged window table.
            int waited = 0;
            while (waited < timeoutMs)
            {
                Thread.Sleep(50);
                waited += 50;
                IntPtr h = NewWindowSince(before);
                if (h == IntPtr.Zero && p != null)
                {
                    // Prefer this process's own window when it has one - it is proof the app
                    // is ready, not merely that some other window opened at the same moment.
                    h = WindowForPid(p.Id);
                }
                if (h != IntPtr.Zero)
                {
                    r.Ok = true;
                    r.Hwnd = h.ToInt64();
                    try { r.Pid = (int)Win.PidOf(h); } catch { r.Pid = p.Id; }
                    r.Title = Win.Title(h);
                    return r;
                }
            }

            // FALL BACK TO A WINDOW THIS APPLICATION ALREADY OWNS.
            //
            // "No NEW window appeared" is not the same as "no window appeared", and treating them
            // as the same thing made the capability unusable in exactly the situation it is most
            // needed. Windows 11 Notepad is a SINGLE-INSTANCE application: launching it with a
            // second document hands the request to the process that is already running and focuses
            // it, rather than creating another window. With any Notepad already open, a run typed
            // into the right document and saved it correctly - and this reported a 15-second
            // timeout, which is a failure that would send a reader looking for a broken application.
            //
            // So before giving up, look for a window owned by this executable that is showing the
            // document we asked for. Matching on the FILE NAME rather than merely "some window of
            // this process" is what makes it safe: a wrong document is worse than no document,
            // because the caller would type into whatever it found.
            IntPtr adopted = AdoptWindowFor(exe, path);
            if (adopted == IntPtr.Zero && isBrowser && !string.IsNullOrWhiteSpace(url))
            {
                adopted = AdoptBrowserWindow(exe);
            }
            if (adopted != IntPtr.Zero)
            {
                r.Ok = true;
                r.Hwnd = adopted.ToInt64();
                r.Pid = (int)Win.PidOf(adopted);
                r.Title = Win.Title(adopted);
                r.Adopted = true;
                return r;
            }

            r.Error = exe + " started but no window appeared within "
                    + (timeoutMs / 1000) + "s (this happens for apps that need a first-run setup, "
                    + "or that were blocked by policy)";
            return r;
        }

        /// A window already showing `path`, owned by a process running `exe`.
        ///
        /// Empty `path` means the caller did not name a document, and an unnamed window cannot be
        /// identified as the right one - so nothing is adopted and the caller's original timeout
        /// stands.
        static IntPtr AdoptWindowFor(string exe, string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return IntPtr.Zero;
            string leaf = System.IO.Path.GetFileNameWithoutExtension(path);
            if (leaf.Length < 3) return IntPtr.Zero;   // too short to identify a document safely
            string processName = System.IO.Path.GetFileNameWithoutExtension(exe).ToLowerInvariant();

            var found = IntPtr.Zero;
            Win.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Win.IsWindowVisible(h)) return true;
                string title = Win.Title(h);
                if (title.Length == 0) return true;
                if (title.IndexOf(leaf, StringComparison.OrdinalIgnoreCase) < 0) return true;
                uint pid; Win.GetWindowThreadProcessId(h, out pid);
                try
                {
                    string owner = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                    if (owner != processName) return true;
                }
                catch { return true; }
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        /// Adopt a browser window after it handed the request to an instance already running.
///
/// Chromium browsers are SINGLE-INSTANCE for navigation. Asking for a page while the browser is
/// already open does not create a process with a window: the running instance opens a tab and the
/// newly started process exits immediately, so waiting for ITS window waits for something that
/// will never exist. The first version of this therefore reported "no window appeared within 30s"
/// for a launch that had visibly succeeded - the page really did open.
///
/// Matching on the browser PROCESS is the whole of the safety argument here, and it is why this
/// is separate from AdoptWindowFor. A browser's window is not identified by a document name, so
/// there is nothing narrower to match on. But the search is restricted to a visible, titled
/// window owned by this exact executable - not "any window", and not another browser. Two
/// browsers open at once is the normal state of this machine, and mistaking one for the other
/// would send a mission typing into the wrong one.
///
/// Returns the largest such window, which in practice is the tab strip's parent rather than a
/// stray dialog or the "restore pages?" bubble left by a previous crash.
static IntPtr AdoptBrowserWindow(string exe)
{
    string processName = System.IO.Path.GetFileNameWithoutExtension(exe).ToLowerInvariant();
    var best = IntPtr.Zero;
    long bestArea = 0;

    Win.EnumWindows(delegate(IntPtr h, IntPtr l)
    {
        if (!Win.IsWindowVisible(h)) return true;
        string title = Win.Title(h);
        if (title.Length == 0) return true;
        // Browser chrome is "msedge"/"chrome"; a save dialog or a restore bubble is not the
        // process we asked for, and the process check below rejects it anyway. Kept as a cheap
        // early out because EnumWindows visits every window on the desktop.
        if (title.IndexOf("restore pages", StringComparison.OrdinalIgnoreCase) >= 0) return true;

        uint pid; Win.GetWindowThreadProcessId(h, out pid);
        try
        {
            string owner = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
            if (owner != processName) return true;
        }
        catch { return true; }

        Win.RECT r;
        if (!Win.GetWindowRect(h, out r)) return true;
        long area = (long)Math.Abs(r.Right - r.Left) * Math.Abs(r.Bottom - r.Top);
        if (area > bestArea) { bestArea = area; best = h; }
        return true;
    }, IntPtr.Zero);
    return best;
}

        /// Every visible, titled top-level handle currently on screen.
        static HashSet<IntPtr> VisibleHandles()
        {
            var set = new HashSet<IntPtr>();
            Win.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (Win.IsWindowVisible(h) && Win.Title(h).Trim().Length > 0) set.Add(h);
                return true;
            }, IntPtr.Zero);
            return set;
        }

        /// The first visible, titled window whose handle was not in the "before" set.
        static IntPtr NewWindowSince(HashSet<IntPtr> before)
        {
            var found = IntPtr.Zero;
            Win.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Win.IsWindowVisible(h)) return true;
                if (Win.Title(h).Trim().Length == 0) return true;
                if (before.Contains(h)) return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        /// The first visible, titled window owned by this pid, or IntPtr.Zero.
        static IntPtr WindowForPid(int pid)
        {
            var found = IntPtr.Zero;
            uint want = (uint)pid;
            Win.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Win.IsWindowVisible(h)) return true;
                uint p; Win.GetWindowThreadProcessId(h, out p);
                if (p != want) return true;
                // A titled window only. Many processes own invisible helper windows, and
                // focusing one of those produces a taskbar that appears to do nothing.
                if (Win.Title(h).Trim().Length == 0) return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }
    }
}