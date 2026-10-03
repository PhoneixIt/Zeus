// Real UI Automation, used as the primary way to find and act on controls.
//
// WHY THIS FILE EXISTS
//
// The operator's "UIA" was EnumChildWindows plus GetWindowText. That is window
// enumeration, not accessibility, and it has a hard blind spot: Chromium draws its whole
// user interface inside a single Chrome_WidgetWin_1 window with no child HWNDs to walk.
// So for Chrome and Edge - two of the applications the operator most needs to drive -
// the old tree was effectively empty, and the only way to hit a control was to know its
// coordinates in advance. That is exactly the weakness this is meant to remove.
//
// Chromium implements UI Automation on Windows, and so does VS Code. Asking the
// accessibility tree "which control is named Save" is a far more reliable question than
// "where is Save", and it is answerable without the operator knowing anything about the
// application's layout.
//
// SAFETY, WHICH IS THE PART THAT MATTERS HERE
//
// UIA's Invoke and SetValue patterns act on a control WITHOUT going through the input
// path. No mouse event, no keyboard event, nothing the low-level hooks can see. That
// makes them excellent for targeting and dangerous for governance: if these were exposed
// as plain endpoints, they would be a hole straight around the guard, and an automation
// layer could "click" with the guard refusing to inject.
//
// So every action here goes through exactly the same three gates as coordinate
// injection, in the same order:
//
//   1. Verify()        - the caller must name the hwnd, the pid that owns it, and the
//                        title, and the process must be the one the window belongs to.
//   2. Guard.MayInject()- refused while observing, paused, taken over, or emergency
//                        stopped, exactly like a click.
//   3. foreground      - the target must actually be in front. Acting on a background
//                        window's controls is how the wrong thing gets clicked.
//
// Accessibility is how the operator decides WHAT to act on. It is not a way around
// whether it is allowed to act.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Windows.Automation;
using System.Threading;

// NOTE: "using System.Windows;" is deliberately NOT added. Every .cs file here is
// concatenated into ONE compilation unit with hoisted usings, so importing it would make
// Size ambiguous between System.Drawing.Size (used by the indicator) and
// System.Windows.Size throughout the whole host. System.Windows.Rect is therefore
// qualified at the point of use instead.

namespace PortAiOperator
{
    public class Uia
    {
        /// Everything the host publishes about one accessibility element. The rectangle
        /// is UIA's own, so it is the application's statement of where it is, not our
        /// inference from window geometry.
        public class El
        {
            public AutomationElement Ae;
            public string Name, AutomationId, ClassName, ControlType, FullType;
            public int X, Y, W, H;
            public bool Offscreen, Enabled, IsContentElement, IsSelected;
            public List<string> Patterns = new List<string>();
        }

        static string S(object o) { return o == null ? "" : Convert.ToString(o, CultureInfo.InvariantCulture); }

        static El Describe(AutomationElement ae)
        {
            El e = new El();
            e.Ae = ae;
            try
            {
                e.Name = ae.Current.Name;
                e.AutomationId = ae.Current.AutomationId;
                e.ClassName = ae.Current.ClassName;
                ControlType ct = ae.Current.ControlType;
                e.ControlType = ct == null ? "" : ct.ProgrammaticName;
                if (e.ControlType.StartsWith("ControlType.")) e.ControlType = e.ControlType.Substring("ControlType.".Length);
                e.FullType = e.ControlType;
                System.Windows.Rect r = ae.Current.BoundingRectangle;
                e.X = (int)Math.Round(r.X); e.Y = (int)Math.Round(r.Y);
                e.W = (int)Math.Round(r.Width); e.H = (int)Math.Round(r.Height);
                e.Offscreen = ae.Current.IsOffscreen;
                e.Enabled = ae.Current.IsEnabled;
                e.IsContentElement = ae.Current.IsContentElement;
                // IsSelected is the answer to "is this the tab the user is actually
                // looking at", which the OS window title cannot be trusted to give. In
                // VS Code the title reports the last-active editor while keystrokes go to
                // the focused editor, and the two disagree often enough that typing after
                // reading only the title put one file's text inside another file's line.
                // GetCurrentPattern is a method on AutomationElement, not on
                // AutomationElementInformation, so this cannot be folded into the block
                // above; it is a separate call and it legitimately fails for elements that
                // have no selection concept, which is not an error.
                try
                {
                    object sel = ae.GetCurrentPattern(SelectionItemPattern.Pattern);
                    if (sel != null) e.IsSelected = ((SelectionItemPattern)sel).Current.IsSelected;
                }
                catch { }
            }
            catch (Exception ex)
            {
                // A provider that throws on Current must not take the whole search down;
                // note it and continue, because a partial tree beats no tree.
                e.Name = "<<unreadable: " + ex.GetType().Name + ">>";
            }
            // Pattern availability is what decides whether UIA can ACT on an element, as
            // opposed to only describing it. It is worth reporting explicitly.
            try
            {
                if (ae.GetCurrentPattern(InvokePattern.Pattern) != null) e.Patterns.Add("Invoke");
            }
            catch { }
            try
            {
                if (ae.GetCurrentPattern(TogglePattern.Pattern) != null) e.Patterns.Add("Toggle");
            }
            catch { }
            try
            {
                if (ae.GetCurrentPattern(ValuePattern.Pattern) != null) e.Patterns.Add("Value");
            }
            catch { }
            try
            {
                if (ae.GetCurrentPattern(SelectionItemPattern.Pattern) != null) e.Patterns.Add("SelectionItem");
            }
            catch { }
            try
            {
                if (ae.GetCurrentPattern(ExpandCollapsePattern.Pattern) != null) e.Patterns.Add("ExpandCollapse");
            }
            catch { }
            try
            {
                if (ae.GetCurrentPattern(ScrollPattern.Pattern) != null) e.Patterns.Add("Scroll");
            }
            catch { }
            try
            {
                if (ae.GetCurrentPattern(TextPattern.Pattern) != null) e.Patterns.Add("Text");
            }
            catch { }
            return e;
        }

        public static string ElJson(El e, int index)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"index\":").Append(index)
              .Append(",\"name\":\"").Append(Esc(e.Name)).Append("\"")
              .Append(",\"automationId\":\"").Append(Esc(e.AutomationId)).Append("\"")
              .Append(",\"className\":\"").Append(Esc(e.ClassName)).Append("\"")
              .Append(",\"controlType\":\"").Append(Esc(e.ControlType)).Append("\"")
              .Append(",\"rect\":[").Append(e.X).Append(',').Append(e.Y).Append(',').Append(e.W).Append(',').Append(e.H).Append("]")
              .Append(",\"offscreen\":").Append(e.Offscreen ? "true" : "false")
              .Append(",\"enabled\":").Append(e.Enabled ? "true" : "false")
              .Append(",\"isSelected\":").Append(e.IsSelected ? "true" : "false")
              .Append(",\"patterns\":[");
            for (int i = 0; i < e.Patterns.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(e.Patterns[i]).Append('"'); }
            sb.Append("]}");
            return sb.ToString();
        }

        /// Search one window's accessibility subtree.
        ///
        /// Matching is case-insensitive on Name, AutomationId or ClassName, and all three
        /// are searched so that a caller can identify a control the way the application
        /// names it rather than the way a sighted user describes its position.
        ///
        /// EXACT MATCHES ARE RANKED FIRST, and that is a correction rather than a nicety.
        /// A real web audit asked for a control named "Search" and was handed Chrome's own
        /// "Address and search bar", because substring matching finds "search" inside it. The
        /// call then reported success, typed into the address bar, and navigated the browser
        /// to the search engine's homepage instead of running the search. A targeting layer
        /// that answers with a plausible wrong element and no indication that it did is worse
        /// than one that refuses, because the caller cannot tell the difference.
        ///
        /// So an exact name match always outranks a substring match, and the ordering is
        /// stable within each rank so results remain reproducible.
        public static List<El> Find(IntPtr hwnd, string nameNeedle, string typeNeedle, string idNeedle, int max, bool includeOffscreen)
        {
            List<El> exact = new List<El>();
            List<El> partial = new List<El>();
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            if (root == null) { return exact; }
            AutomationElementCollection all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            int n = all.Count;
            for (int i = 0; i < n; i++)
            {
                if (exact.Count >= max) break;
                El e;
                try { e = Describe(all[i]); } catch { continue; }
                if (!includeOffscreen && (e.Offscreen || e.W <= 0 || e.H <= 0)) continue;
                if (idNeedle.Length > 0 && e.AutomationId.IndexOf(idNeedle, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (typeNeedle.Length > 0 && e.ControlType.IndexOf(typeNeedle, StringComparison.OrdinalIgnoreCase) < 0) continue;

                bool hit = false, isExact = false;
                if (nameNeedle.Length > 0)
                {
                    // Exact first, on any of the three identifying fields.
                    if (string.Equals(e.Name, nameNeedle, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(e.AutomationId, nameNeedle, StringComparison.OrdinalIgnoreCase)
                        || string.Equals(e.ClassName, nameNeedle, StringComparison.OrdinalIgnoreCase))
                    { hit = true; isExact = true; }
                    else if (e.Name.IndexOf(nameNeedle, StringComparison.OrdinalIgnoreCase) >= 0
                        || e.AutomationId.IndexOf(nameNeedle, StringComparison.OrdinalIgnoreCase) >= 0
                        || e.ClassName.IndexOf(nameNeedle, StringComparison.OrdinalIgnoreCase) >= 0)
                    { hit = true; }
                }
                else hit = true;

                if (!hit) continue;
                if (isExact) exact.Add(e); else partial.Add(e);
            }
            // Exact matches first, then substring matches, truncated to the caller's limit.
            List<El> ranked = new List<El>(exact);
            for (int i = 0; i < partial.Count && ranked.Count < max; i++) ranked.Add(partial[i]);
            return ranked;
        }

        /// Click a control through the accessibility interface rather than by moving the
        /// mouse to a point. This is the whole point: the decision of what to click is
        /// made by the application, not by a coordinate we guessed.
        public static string Invoke(IntPtr hwnd, int index, string nameNeedle, string typeNeedle, out string error, out string detail)
        {
            error = null; detail = "";
            List<El> cands = Find(hwnd, nameNeedle ?? "", typeNeedle ?? "", "", 50, false);
            if (cands.Count == 0) { error = "no accessible element matched name='" + nameNeedle + "' type='" + typeNeedle + "'"; return null; }
            if (index < 0 || index >= cands.Count) { error = "index " + index + " out of range; " + cands.Count + " match(es)"; return null; }
            El e = cands[index];
            if (!e.Patterns.Contains("Invoke"))
            {
                // A control that cannot be invoked can often still be SET, and for a
                // checkbox or a menu item that is the real interaction. Try the cheapest
                // alternative rather than failing, but say which one was used.
                if (e.Patterns.Contains("Toggle"))
                {
                    object p = e.Ae.GetCurrentPattern(TogglePattern.Pattern);
                    ((TogglePattern)p).Toggle();
                    detail = "Toggle";
                    return ElJson(e, index);
                }
                if (e.Patterns.Contains("SelectionItem"))
                {
                    object p = e.Ae.GetCurrentPattern(SelectionItemPattern.Pattern);
                    ((SelectionItemPattern)p).Select();
                    detail = "SelectionItem";
                    return ElJson(e, index);
                }
                error = "matched '" + e.Name + "' but it exposes no Invoke/Toggle/SelectionItem pattern (has: " + string.Join(",", e.Patterns.ToArray()) + ")";
                return null;
            }
            object inv = e.Ae.GetCurrentPattern(InvokePattern.Pattern);
            ((InvokePattern)inv).Invoke();
            detail = "Invoke";
            return ElJson(e, index);
        }

        /// Type into a control through ValuePattern, which is a real accessibility
        /// action rather than a stream of synthesised keystrokes. Used where an
        /// application exposes it, and cross-checked afterwards by reading the value
        /// back - an action that reports success is not the same as a value that landed.
        public static string SetValue(IntPtr hwnd, int index, string nameNeedle, string typeNeedle, string text, out string error, out string readBack)
        {
            error = null; readBack = "";
            List<El> cands = Find(hwnd, nameNeedle ?? "", typeNeedle ?? "", "", 50, false);
            if (cands.Count == 0) { error = "no accessible element matched name='" + nameNeedle + "'"; return null; }
            if (index < 0 || index >= cands.Count) { error = "index " + index + " out of range; " + cands.Count + " match(es)"; return null; }
            El e = cands[index];
            if (!e.Patterns.Contains("Value")) { error = "matched '" + e.Name + "' but it exposes no Value pattern (has: " + string.Join(",", e.Patterns.ToArray()) + ")"; return null; }
            object p = e.Ae.GetCurrentPattern(ValuePattern.Pattern);
            ((ValuePattern)p).SetValue(text ?? "");
            try { readBack = ((ValuePattern)p).Current.Value; } catch { readBack = ""; }
            return ElJson(e, index);
        }

        /// Move keyboard focus to a specific control.
        ///
        /// This is the missing half of the story and it is what the VS Code failure
        /// demanded. Opening a file in VS Code - even through a real accessibility call on
        /// the Explorer tree item - leaves the CARET wherever it was. The window title
        /// updates to the newly opened file, so a title check says the right file is in
        /// front, and the next keystrokes then land in the other editor. The evidence was
        /// a file containing
        ///     assert.strictEqual(ad// operator-was-hered(40, 2), 99)
        ///
        /// Both halves were true at once and neither lied: the title really did name
        /// sum.js, and the typing really did go somewhere else. Reading the title cannot
        /// settle this, because the title reports the last-active editor and the keyboard
        /// follows the focus.
        ///
        /// So instead of inferring where the caret is, the operator says where it intends
        /// the caret to be and then asks the application to put it there. SetFocus is the
        /// accessibility equivalent of a user clicking the tab, and it is far more
        /// dependable than a keystroke that happens to switch tabs. It is also read back
        /// afterwards so a caller can confirm focus actually landed rather than assume it.
        ///
        /// Like Invoke and SetValue, SetFocus changes application state without producing
        /// an input event, so it is gated by the same Verify / MayInject / foreground
        /// sequence at the call site. Focusing a control is not typing into it, but it is
        /// still a mutation of what the human is about to interact with, and it is exactly
        /// the step that decides where their next keystroke lands.
        public static string Focus(IntPtr hwnd, int index, string nameNeedle, string typeNeedle,
            out string error, out string readBack)
        {
            error = null; readBack = "";
            List<El> cands = Find(hwnd, nameNeedle ?? "", typeNeedle ?? "", "", 50, false);
            if (cands.Count == 0) { error = "no accessible element matched name='" + nameNeedle + "' type='" + typeNeedle + "'"; return null; }
            if (index < 0 || index >= cands.Count) { error = "index " + index + " out of range; " + cands.Count + " match(es)"; return null; }
            El e = cands[index];
            try
            {
                e.Ae.SetFocus();
            }
            catch (Exception ex)
            {
                error = "SetFocus on '" + e.Name + "' failed: " + ex.GetType().Name + " - " + ex.Message;
                return null;
            }
            // Read focus back rather than reporting the SetFocus call as success. Several
            // providers accept SetFocus and do nothing, and "I asked" is not "it happened".
            Thread.Sleep(140);
            try
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                readBack = focused == null ? "" : focused.Current.Name;
                if (focused != null)
                {
                    int ea = focused.Current.NativeWindowHandle;
                    // A focused child may report a different native handle than the
                    // document that contains it, so compare names as well.
                    readBack += "|" + (ea == 0 ? "0" : ea.ToString()) + "|" + e.Name;
                }
            }
            catch { readBack = e.Name; }
            return ElJson(e, index);
        }

        /// Which of several controls the application itself considers current.
        ///
        /// A plain "is anything focused" test is not enough once a window holds several
        /// panes. The useful question is "which one of the things I care about is
        /// selected", and for tabs, tree items and list entries the application answers it
        /// with SelectionItemPattern.IsSelected. Reporting the matches lets a caller assert
        /// "the tab I am about to type into is the selected one" before typing, instead of
        /// after.
        public static string WhichSelected(IntPtr hwnd, string typeNeedle, int max)
        {
            List<El> all = Find(hwnd, "", typeNeedle ?? "", "", max <= 0 ? 200 : max, true);
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"selected\":[");
            int n = 0;
            for (int i = 0; i < all.Count; i++)
            {
                if (!all[i].IsSelected) continue;
                if (n > 0) sb.Append(',');
                sb.Append(ElJson(all[i], i));
                n++;
            }
            sb.Append("],\"count\":").Append(n).Append('}');
            return sb.ToString();
        }

        /// Read a control's text, for verification after an action.
        public static string ReadText(IntPtr hwnd, int index, string nameNeedle, string typeNeedle, out string error)
        {
            error = null;
            List<El> cands = Find(hwnd, nameNeedle ?? "", typeNeedle ?? "", "", 50, false);
            if (cands.Count == 0) { error = "no accessible element matched name='" + nameNeedle + "'"; return null; }
            if (index < 0 || index >= cands.Count) { error = "index " + index + " out of range"; return null; }
            El e = cands[index];
            string text = "";
            if (e.Patterns.Contains("Value"))
            {
                try { text = ((ValuePattern)e.Ae.GetCurrentPattern(ValuePattern.Pattern)).Current.Value; } catch { }
            }
            if (text.Length == 0 && e.Patterns.Contains("Text"))
            {
                try
                {
                    var tp = (TextPattern)e.Ae.GetCurrentPattern(TextPattern.Pattern);
                    text = tp.DocumentRange.GetText(-1);
                }
                catch { }
            }
            if (text.Length == 0) text = e.Name;
            return "{\"text\":\"" + Esc(text) + "\",\"source\":\"" +
                (e.Patterns.Contains("Value") ? "Value" : e.Patterns.Contains("Text") ? "Text" : "Name") + "\"}";
        }

        /// A bounded overview of what this window actually exposes, so the operator can
        /// see the shape of an application instead of guessing at it.
        public static string Survey(IntPtr hwnd, int max, bool includeOffscreen)
        {
            List<El> all = Find(hwnd, "", "", "", max, includeOffscreen);
            Dictionary<string, int> byType = new Dictionary<string, int>();
            foreach (El e in all)
            {
                if (!byType.ContainsKey(e.ControlType)) byType[e.ControlType] = 0;
                byType[e.ControlType]++;
            }
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"count\":").Append(all.Count).Append(",\"byType\":{");
            bool first = true;
            foreach (var kv in byType)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"').Append(Esc(kv.Key)).Append("\":").Append(kv.Value);
            }
            sb.Append("},\"elements\":[");
            for (int i = 0; i < all.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(ElJson(all[i], i));
            }
            sb.Append("]}");
            return sb.ToString();
        }

        static string Esc(string s)
        {
            if (s == null) return "";
            var b = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') b.Append('\\').Append(c);
                else if (c == '\n') b.Append("\\n");
                else if (c == '\r') b.Append("\\r");
                else if (c == '\t') b.Append("\\t");
                else if (c < 32) b.Append(' ');
                else b.Append(c);
            }
            return b.ToString();
        }
    }
}
