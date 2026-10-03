// Host-enforced verification of WHICH FILE will receive injected keystrokes in VS Code.
//
// THE PROBLEM THIS SOLVES
//
// An earlier run typed into the wrong file and corrupted it, producing
//
//     assert.strictEqual(ad// operator-was-hered(40, 2), 99
//
// Every instrument the operator had was inadequate, and each failed in a way that looked
// like success:
//
//   - the OS window TITLE reports the last-ACTIVE editor, while the keyboard follows the
//     FOCUSED element. It read "sum.js" while the caret was in sum.test.js. Correct value,
//     wrong question.
//   - TabItem IsSelected came back empty, then wrong. VS Code's Electron provider does not
//     maintain it.
//   - SetFocus on the editor document is ACCEPTED and then does nothing:
//     AutomationElement.FocusedElement still reports the top-level window.
//
// And the measurement that closed the investigation was this. Dumping every Tab and TabItem
// in a VS Code window shows the only three Tab controls are the Activity Bar, the bottom
// panel, and the Chat view:
//
//     [9,97,46,266]    "Active View Switcher"   (Explorer / Search / SCM / Debug / Extensions)
//     [68,711,451,40]  "Active View Switcher"   (Problems / Output / Debug Console / Terminal / Ports)
//     [1553,44,59,41]  "Active View Switcher"   (Chat)
//
// THERE IS NO EDITOR TAB STRIP IN THE ACCESSIBILITY TREE. VS Code's Electron accessibility
// provider does not expose the open-editors group as accessible elements at all in this
// build. So the operator cannot enumerate which files are open, and therefore cannot rule
// out that some other editor holds the caret. No amount of reading UIA will fix that.
//
// THE INSIGHT: DO NOT INFER, ELIMINATE
//
// If exactly ONE editor is open, then "which editor holds the caret" cannot be wrong - the
// caret has nowhere else to be. That converts an unsolvable inference into a checkable
// structural fact.
//
// So the proof is built as a precondition rather than an observation:
//
//   1. ASSERT no editor is open      - the window title carries no file name. When a file is
//                                     open, VS Code prefixes the title with it; with zero
//                                     editors the title is just "<workspace> - Visual Studio
//                                     Code". This is the application's own statement, and
//                                     unlike the caret it is stable and unambiguous.
//   2. OPEN exactly one, by name     - "code --reuse-window <abs path>" is VS Code's OWN
//                                     command interface. The application performs the open
//                                     and places its caret. We are not simulating a click; we
//                                     are asking the editor to do what it does for a user.
//   3. ASSERT the title NOW names it - if VS Code had not actually opened the file, the
//                                     title would not change. This is a post-condition on the
//                                     application's behaviour, not an inference about focus.
//   4. THEN, AND ONLY THEN, ALLOW INJECTION.
//
// Step 3 is what makes this evidence rather than optimism: it is possible for the command to
// fail, be too slow, or be rejected, and in every one of those cases the title will not name
// the file and the gate refuses.
//
// WHY THE GATE LIVES IN THE HOST AND NOT IN THE TEST
//
// A test-side check is a suggestion. Any caller that forgets it, or is written by someone in
// a hurry, silently regains the ability to type into an unknown buffer - which is exactly
// the failure that corrupted a file. So the authorization is minted here, bound to a specific
// hwnd and a specific file path with a short expiry, and /type REFUSES without a live one.
// The refusal is not "please verify first"; the keystrokes cannot be sent at all.
//
// The filesystem invariant remains the second, independent line of defence: the intended file
// must change and no other file may change. This gate prevents typing into an unknown target;
// the invariant catches a target that lied.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace PortAiOperator
{
    public class VsEdit
    {
        /// An authorization to type into one specific file in one specific window.
        /// Short-lived on purpose: the world can change between authorizing and typing, and a
        /// stale authorization is exactly the kind of thing that must not be trusted.
        public class Auth
        {
            public IntPtr Hwnd;
            public string Path;
            public DateTime Expires;
        }

        static readonly object gate = new object();
        static readonly Dictionary<IntPtr, Auth> live = new Dictionary<IntPtr, Auth>();

        // Deliberately short. Enough to type a line and save; far too short to survive
        // someone switching windows, opening a different file, or going away for lunch.
        public const int AuthLifetimeMs = 20000;

        public static void Revoke(IntPtr hwnd)
        {
            lock (gate) { live.Remove(hwnd); }
        }

        public static void RevokeAll()
        {
            lock (gate) { live.Clear(); }
        }

        /// Is there a live authorization for this window, for THIS file, right now?
        /// A window with a valid authorization for a different file is not authorized - that
        /// distinction is the whole point, and treating it as "any live auth" would reintroduce
        /// the original bug with extra steps.
        public static bool Authorized(IntPtr hwnd, string path)
        {
            lock (gate)
            {
                Auth a;
                if (!live.TryGetValue(hwnd, out a)) return false;
                if (DateTime.UtcNow > a.Expires) { live.Remove(hwnd); return false; }
                if (path == null) return false;
                return string.Equals(a.Path, path, StringComparison.OrdinalIgnoreCase);
            }
        }

        public static string Peek(IntPtr hwnd)
        {
            lock (gate)
            {
                Auth a;
                if (!live.TryGetValue(hwnd, out a)) return "(none)";
                if (DateTime.UtcNow > a.Expires) return "(expired)";
                return a.Path + " for another " + Math.Max(0, (int)(a.Expires - DateTime.UtcNow).TotalMilliseconds) + "ms";
            }
        }

        /// Does this window title carry a file name, or is it just the workspace?
        ///
        /// This is the one signal that reliably distinguishes "an editor is open" from "no
        /// editor is open" in VS Code. With a file open the title is
        ///     sum.js - portai-vscode-proof - Visual Studio Code
        /// and with none open it is
        ///     portai-vscode-proof - Visual Studio Code
        ///
        /// It is used ONLY to establish the zero-editors precondition, never to decide where
        /// the caret is. Those are different questions, and conflating them is what caused the
        /// original corruption.
        public static bool TitleHasOpenFile(string title)
        {
            if (string.IsNullOrEmpty(title)) return false;
            // Strip the trailing " - Visual Studio Code" (and any dirty marker) and see
            // whether what remains is more than the workspace folder name.
            string t = title;
            int idx = t.LastIndexOf(" - Visual Studio Code", StringComparison.OrdinalIgnoreCase);
            if (idx > 0) t = t.Substring(0, idx);
            t = t.Trim();
            // A dirty marker is a leading bullet/asterisk; it is not part of the name.
            t = t.TrimStart('\u2022', '*', '\u25CF', ' ').Trim();
            if (t.Length == 0) return false;
            // "foo - bar - Visual Studio Code" -> "foo - bar" is a file + workspace. A bare
            // workspace name has no " - " separator before the product suffix.
            int sep = t.LastIndexOf(" - ", StringComparison.Ordinal);
            if (sep < 0) return false;                 // just the workspace: no editor open
            string left = t.Substring(0, sep).Trim();   // should be the file name
            if (left.Length == 0) return false;
            // Reject anything that is only punctuation or whitespace.
            foreach (char c in left) { if (char.IsLetterOrDigit(c)) return true; }
            return false;
        }

        /// Ask VS Code to open exactly one file, through VS Code's own command interface.
        ///
        /// "code --reuse-window" is the documented way to tell a running VS Code to open a
        /// file in the window that is already open. The application performs the open and
        /// places its own caret. Nothing here imitates a click or guesses at a coordinate.
        ///
        /// The caller has already asserted that NO editor is open, so after this call there
        /// is exactly one, and the caret is in it by construction rather than by inference.
        public static string RunOpenCommand(string codeExe, string file, int timeoutMs)
        {
            var psi = new ProcessStartInfo
            {
                FileName = codeExe,
                Arguments = "--reuse-window \"" + file + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            // The CLI talks to the running instance over a pipe; inheriting this process's
            // redirected stdio would make it wait for input that never arrives.
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            using (Process p = Process.Start(psi))
            {
                if (p == null) return "could not start " + codeExe;
                string so = "", se = "";
                Thread o = new Thread(() => { try { so = p.StandardOutput.ReadToEnd(); } catch { } });
                Thread e = new Thread(() => { try { se = p.StandardError.ReadToEnd(); } catch { } });
                o.IsBackground = true; e.IsBackground = true;
                o.Start(); e.Start();
                bool exited = p.WaitForExit(timeoutMs <= 0 ? 30000 : timeoutMs);
                try { if (!exited) p.Kill(); } catch { }
                return (exited ? "ok" : "timeout")
                    + " exit=" + SafeExit(p)
                    + " out=" + Trim(so) + " err=" + Trim(se);
            }
        }

        static string SafeExit(Process p)
        {
            try { return p.HasExited ? p.ExitCode.ToString() : "n/a"; } catch { return "?"; }
        }

        static string Trim(string s)
        {
            if (s == null) return "";
            s = s.Replace("\r", " ").Replace("\n", " ").Trim();
            if (s.Length > 200) s = s.Substring(0, 200) + "...";
            return s;
        }

        /// Grant the authorization, and simultaneously invalidate any other one.
        public static void Grant(IntPtr hwnd, string path)
        {
            lock (gate)
            {
                live[hwnd] = new Auth { Hwnd = hwnd, Path = path, Expires = DateTime.UtcNow.AddMilliseconds(AuthLifetimeMs) };
            }
        }
    }
}
