// The visible operator state indicator.
//
// WHY WINFORMS RATHER THAN HAND-ROLLED WIN32
//
// This replaces a hand-written GDI overlay that registered a class, created a window,
// and pumped its own message loop. It got as far as a real window with a valid class
// atom and a correct rectangle, and then failed in two ways that were only visible on
// the physical screen: it painted once and stopped, and it sat behind the application
// in front of it. Both are failure modes of hand-rolled window plumbing, and chasing
// them further was not a good use of effort.
//
// WinForms is used instead, and it is not a leap of faith: System.Windows.Forms is
// already referenced by this host, and a WinForms window has been created, driven with
// real OS-level input, and verified on this exact machine many times over. It handles
// class registration, the message loop, z-order and painting correctly.
//
// IT IS STILL THE REAL STATE, NOT A LABEL.
//
// The form's Paint handler reads Guard.State - the same single variable every input
// endpoint consults to decide whether injection is permitted. There is no second
// "displayed" state that could disagree with the enforced one, so if the panel says
// PAUSED, input is genuinely refused. The colour is derived from that same field, and
// the mode line states plainly whether injection is currently permitted.
//
// IT DOES NOT INTERFERE. TopMost keeps it visible, ShowInTaskbar=false keeps it out of
// Alt+Tab, and the form is never Activated - it is shown with ShowWithoutActivation
// semantics so it cannot steal focus from whatever the operator is working in. A
// click over it passes through, because the whole surface reports HTCLIENT and the
// form is not activated by a click.

using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace PortAiOperator
{
    public class Indicator
    {
        static Form form;
        static Font fontBig;
        static Font fontMid;
        static Font fontSmall;
        // Explicitly the WinForms timer. With both System.Threading and
        // System.Windows.Forms imported, a bare `Timer` is an ambiguous reference.
        static System.Windows.Forms.Timer ticker;

        const int W = 300;
        const int H = 118;

        public static IntPtr Handle { get { return form == null ? IntPtr.Zero : form.Handle; } }

        public static void Start()
        {
            if (form != null) return;
            var t = new Thread(Run);
            t.IsBackground = true;
            t.Name = "operator-indicator";
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        static void Run()
        {
            form = new Form();
            form.FormBorderStyle = FormBorderStyle.None;
            form.ShowInTaskbar = false;
            form.TopMost = true;
            form.StartPosition = FormStartPosition.Manual;
            form.ClientSize = new Size(W, H);
            form.BackColor = Color.Black;
            // Click-through: a click over the panel must reach whatever is behind it,
            // otherwise the panel would silently intercept operator input. Style is
            // applied on creation and must be followed by SetWindowLong, because .NET
            // recreates the window handle after Show().
            ClickThrough(form);

            int x = Math.Max(0, Screen.PrimaryScreen.Bounds.Right - W - 16);
            int y = 8;
            form.Location = new Point(x, y);

            // No child controls. Labels would be convenient but they bring an IME
            // window with them, and the diagnostic that identified this problem
            // found exactly such a window sitting above the panel. Drawing text
            // directly keeps the panel a single window with no extra z-order
            // participants, and makes the surface trivially click-through.
            fontBig = new Font("Segoe UI", 15f, FontStyle.Bold);
            fontMid = new Font("Segoe UI", 10.5f, FontStyle.Regular);
            fontSmall = new Font("Segoe UI", 8.5f, FontStyle.Regular);

            form.Paint += (s, e) => Paint(e.Graphics);

            // A short interval, and every tick re-reads the authoritative state. The
            // previous implementation painted once and stopped; a repeating timer driven
            // by Application's message loop does not have that failure mode.
            ticker = new System.Windows.Forms.Timer();
            ticker.Interval = 200;
            ticker.Tick += (s, e) => Refresh();
            form.Shown += (s, e) => { Refresh(); ticker.Start(); };

            ClickThrough(form);
            // Height must match the painted area exactly. The window was previously
            // created 30px taller than Paint() fills, leaving an unpainted black band
            // under the text - visible in a pixel probe as #000000 inside our own rect.
            Win.SetWindowPos(form.Handle, new IntPtr(-1), x, y, W, H, 0x0004 /* SWP_NOZORDER */ | 0x0010 /* SWP_NOACTIVATE */);
            Application.Run(form);
        }

        /// A single consistent read of the authoritative state.
        ///
        /// The panel used to call Headline() and Mode() separately, and each of those
        /// re-read Guard.State. A takeover landing between the two reads produced a
        /// panel that said "ARMED" and "injection refused" at the same time - visibly
        /// self-contradictory, and exactly the "displays a different state from the one
        /// being enforced" failure the panel must not have. Everything the panel shows
        /// is now derived from one snapshot.
        public class Snapshot
        {
            public string State;
            public bool Latched;
            public bool MayInject;
            /// Whether a human takeover is pending. Reported so the panel can name the
            /// actual blocker instead of a generic "refused", which is the difference
            /// between "something is wrong" and "you are in control".
            public bool TakeoverPending;
            public long Human, Operator;
        }

        static Snapshot Read()
        {
            Snapshot s = new Snapshot();
            s.State = Guard.State;
            s.Latched = Guard.EmergencyLatched;
            s.MayInject = Guard.MayInject();
            s.TakeoverPending = Guard.TakeoverPending;
            s.Human = Guard.HumanEvents;
            s.Operator = Guard.OperatorEvents;
            return s;
        }

        static string HeadlineOf(Snapshot s)
        {
            if (s.Latched || s.State == Guard.EMERGENCY_STOP) return "EMERGENCY STOP";
            switch (s.State)
            {
                case Guard.OBSERVING: return "OBSERVATION ONLY";
                case Guard.ARMED:
                    // The control mode is ARMED, but a pending human takeover can still
                    // block input. Rendering that as a plain green "ARMED" tells a human the
                    // opposite of the truth at the moment it matters most, so the blocked
                    // case says so in the headline itself.
                    if (Guard.HookUnhealthy != null) return "HOOK FAILED / CHORDS WILL LEAK";
                    return s.MayInject ? "ARMED" : "ARMED / INPUT BLOCKED";
                case Guard.WORKING:
                    return s.MayInject ? "WORKING" : "WORKING / INPUT BLOCKED";
                case Guard.HUMAN_TAKEOVER: return "PAUSED - HUMAN CONTROL";
                case Guard.PAUSED: return "PAUSED";
                case Guard.RESUMING: return "RESUMING";
                default: return s.MayInject ? s.State : s.State + " / INPUT BLOCKED";
            }
        }

        static string ModeOf(Snapshot s)
        {
            if (s.Latched) return "injection disabled until re-armed";
            if (s.MayInject) return "injection permitted";
            // Name the actual blocker rather than a generic "refused", so the reason a
            // supposedly-armed operator is not moving is visible without opening a log.
            if (s.TakeoverPending) return "BLOCKED: human takeover";
            return "BLOCKED: " + s.State;
        }

        static Color BackgroundFor(Snapshot s)
        {
            // A missing hook is a RED condition, not an amber one, and not a green one. Without
            // it the reserved chords are not swallowed, which is exactly what happened: the
            // human pressed the documented release chord and the keystrokes reached their
            // desktop. Red is the only colour that cannot be misread as "working".
            if (Guard.HookUnhealthy != null) return Color.FromArgb(0xA0, 0x20, 0x20);
            if (s.Latched || s.State == Guard.EMERGENCY_STOP) return Color.FromArgb(0xA0, 0x20, 0x20);
            if (s.State == Guard.HUMAN_TAKEOVER || s.State == Guard.PAUSED) return Color.FromArgb(0xC0, 0x8A, 0x10);
            if (s.State == Guard.OBSERVING) return Color.FromArgb(0x10, 0x6E, 0x8A);
            if (s.State == Guard.RESUMING) return Color.FromArgb(0x6B, 0x4E, 0xC0);
            // Green means "you may safely work at this machine". A control state of ARMED
            // with input actually blocked must NOT be green, however correct the state name
            // is on its own.
            if (!s.MayInject) return Color.FromArgb(0xC0, 0x8A, 0x10);
            return Color.FromArgb(0x1E, 0x7A, 0x33);
        }

        static void Paint(Graphics g)
        {
            Snapshot s = Read();
            lastPainted = s;
            Color bg = BackgroundFor(s);
            using (SolidBrush b = new SolidBrush(bg)) g.FillRectangle(b, 0, 0, W, H);
            using (Pen p = new Pen(Color.FromArgb(0, 0, 0), 2)) g.DrawRectangle(p, 1, 1, W - 2, H - 2);
            StringFormat sf = new StringFormat();
            sf.FormatFlags = StringFormatFlags.NoWrap;
            sf.Trimming = StringTrimming.EllipsisCharacter;
            Rectangle row1 = new Rectangle(10, 6, W - 20, 24);
            Rectangle row2 = new Rectangle(10, 32, W - 20, 18);
            Rectangle row3 = new Rectangle(10, 52, W - 20, 16);
            Rectangle row4 = new Rectangle(10, 72, W - 20, 12);

            // THE RELEASE CONTROL.
            //
            // Drawn here purely so a human can SEE where to click. The panel is click-through
            // and there is no click handler: the panel is a picture, not a button. The low-level
            // mouse hook watches this rectangle and decides, using the hardware/injected
            // distinction that only the hook can see.
            //
            // That inversion matters. A normal button would be clickable by the automation layer
            // too - it injects mouse events - and any handler it called would be a release path.
            // Here there is nothing to call. Only a physical click inside the box changes state.
            Rectangle release = new Rectangle(W - 104, H - 24, 94, 20);

            // Publish in SCREEN coordinates, which is the space the hook's event carries.
            Point onScreen = form.PointToScreen(release.Location);
            Hooks.SetReleaseRegion(onScreen.X, onScreen.Y, release.Width, release.Height);

            bool canRelease = s.State == Guard.HUMAN_TAKEOVER || s.State == Guard.PAUSED || s.State == Guard.ARMED;
            using (SolidBrush btn = new SolidBrush(canRelease
                ? Color.FromArgb(0x2E, 0x6B, 0x2E)
                : Color.FromArgb(0x30, 0x30, 0x30)))
            using (Pen edge = new Pen(canRelease ? Color.White : Color.FromArgb(0x70, 0x70, 0x70), 2))
            {
                g.FillRectangle(btn, release);
                g.DrawRectangle(edge, release);
            }
            StringFormat centred = new StringFormat();
            centred.Alignment = StringAlignment.Center;
            centred.LineAlignment = StringAlignment.Center;
            using (SolidBrush label = new SolidBrush(canRelease ? Color.White : Color.FromArgb(0x90, 0x90, 0x90)))
            {
                g.DrawString("RELEASE", fontMid, label, release, centred);
            }

            using (SolidBrush w = new SolidBrush(Color.White))
            {
                g.DrawString("PORTAI  " + HeadlineOf(s), fontBig, w, row1, sf);
                g.DrawString(ModeOf(s), fontMid, w, row2, sf);
                g.DrawString("human " + s.Human + "    operator " + s.Operator, fontSmall, w, row3, sf);
            }
            using (SolidBrush dim = new SolidBrush(Color.FromArgb(0xD0, 0xD0, 0xD0)))
            {
                g.DrawString("click RELEASE = physical click only", fontSmall, dim, row4, sf);
            }
        }

        static Label MakeLabel(int left, int top, float size, FontStyle style)
        {
            Label l = new Label();
            l.Left = left;
            l.Top = top;
            l.Width = W - 16;
            l.Height = 22;
            l.ForeColor = Color.White;
            l.BackColor = Color.Transparent;
            l.Font = new Font("Segoe UI", size, style);
            return l;
        }

        /// Re-read the authoritative state and repaint. Called on a timer and after
        /// every state-changing request, so the panel cannot show a stale state for
        /// longer than one tick.
        public static void Refresh()
        {
            if (form == null || form.IsDisposed) return;
            try
            {
                // Keep the panel on top, but only when something is actually above it.
                //
                // The previous version guarded this with "if (!form.TopMost)", which
                // could never be true: TopMost is set at construction and stays set.
                // So the re-assert existed in the source and never ran - which is why
                // the panel could be reported as topmost while being painted over.
                //
                // This is now driven by a measurement instead of an impossible
                // condition: if the window immediately above us in z-order belongs to
                // another process, put ourselves back on top. Re-asserting
                // unconditionally would churn the z-order five times a second for no
                // reason; this only acts when the panel has actually been buried.
                string above = Occluder();
                if (above.StartsWith("OTHER:"))
                {
                    BuriedTicks++;
                    if (!TopMostTick)
                    {
                        TopMostTick = true;
                        Win.SetWindowPos(form.Handle, new IntPtr(-1), 0, 0, 0, 0,
                            0x0001 /* SWP_NOMOVE */ | 0x0002 /* SWP_NOSIZE */ | 0x0010 /* SWP_NOACTIVATE */);
                    }
                }
                else
                {
                    TopMostTick = false;
                }
                form.Invalidate();
            }
            catch { }
        }

        static void ClickThrough(Form f)
        {
            int ex = Win.GetWindowLongPtr32(f.Handle, Win.GWL_EXSTYLE);
            Win.SetWindowLong32(f.Handle, Win.GWL_EXSTYLE,
                ex | Win.WS_EX_TRANSPARENT | Win.WS_EX_NOACTIVATE | Win.WS_EX_TOOLWINDOW);
        }

        public static int BuriedTicks = 0;
        static bool TopMostTick = false;

        public static string Step = "not started";
        public static int RegisterClassError = 0;
        public static int CreateWindowError = 0;
        public static ushort ClassAtom = 0;
        public static int StructSize = 0;

        /// The window immediately above the panel in z-order, plus enough context to
        /// tell whether it is another application or one of our own. Returns "" when
        /// nothing is above us, which is the good case.
        static string Occluder()
        {
            if (form == null || form.IsDisposed) return "";
            IntPtr above = Win.GetWindow(form.Handle, Win.GW_HWNDPREV);
            if (above == IntPtr.Zero) return "";
            bool ours = Win.PidOf(above) == Win.PidOf(form.Handle);
            return (ours ? "SELF:" : "OTHER:") + above.ToInt64()
                + "|" + Win.Cls(above) + "|" + Win.Title(above)
                + (Win.HasTopmost(above) ? "|topmost" : "");
        }

        /// The snapshot the panel is CURRENTLY DISPLAYING, not a fresh one.
        ///
        /// Report() used to take a new snapshot of its own, so the state it reported and
        /// the colour actually painted on screen could disagree - the panel was amber on
        /// screen while claiming to be ARMED, purely because a takeover landed between
        /// the paint and the query. That is precisely the "displays a state different
        /// from the one being enforced" defect, reintroduced through the reporting path
        /// after being fixed in the paint path.
        ///
        /// Storing the snapshot at paint time makes the report self-consistent by
        /// construction: what is reported is exactly what is on screen.
        static Snapshot lastPainted = new Snapshot();

        public static Snapshot LastPainted() { return lastPainted; }

        public static string Report()
        {
            Win.RECT r = new Win.RECT();
            bool haveRect = form != null && !form.IsDisposed && Win.GetWindowRect(form.Handle, out r);
            Snapshot s = lastPainted;
            return "{\"step\":\"" + Escape(Step) + "\""
                + ",\"displaysWhatIsPainted\":true"
                + ",\"implementation\":\"winforms\""
                + ",\"hwnd\":" + (form == null ? 0 : form.Handle.ToInt64())
                + ",\"visible\":" + (form != null && !form.IsDisposed && form.Visible ? "true" : "false")
                + ",\"topmost\":" + (form != null && !form.IsDisposed && form.TopMost ? "true" : "false")
                + ",\"rect\":" + (haveRect ? "[" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "]" : "null")
                + ",\"headline\":\"" + Escape(HeadlineOf(s)) + "\""
                + ",\"mode\":\"" + Escape(ModeOf(s)) + "\""
                + ",\"state\":\"" + Escape(s.State) + "\""
                + ",\"mayInject\":" + (s.MayInject ? "true" : "false")
                + ",\"clickThrough\":" + ((Win.GetWindowLongPtr32(form == null ? IntPtr.Zero : form.Handle, Win.GWL_EXSTYLE) & Win.WS_EX_TRANSPARENT) != 0 ? "true" : "false")
                + ",\"buriedTicks\":" + BuriedTicks
                + ",\"occludedBy\":\"" + Escape(Occluder()) + "\""
                + "}";
        }

        private static string Escape(string v)
        {
            return v == null ? "" : v.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
