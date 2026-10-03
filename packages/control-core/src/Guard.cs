// Human-takeover safety, control state, and a visible state indicator.
//
// THE CENTRAL PROBLEM
//
// The operator injects real mouse and keyboard input. A naive takeover detector
// cannot tell those apart from the human using the same desk, and GetLastInputInfo
// cannot either: the operator's own injected events update exactly the same system
// input state. A detector built on it would either ignore the human entirely, or
// treat every operator action as a takeover and deadlock.
//
// THE SOLUTION: PROVE OWNERSHIP, DO NOT INFER IT
//
// Windows low-level input hooks (WH_KEYBOARD_LL / WH_MOUSE_LL) see every input
// event before it is delivered, and each event carries two things that let ownership
// be established rather than guessed:
//
//   * an INJECTED flag (LLKHF_INJECTED / LLMHF_INJECTED) saying the event was
//     synthesised rather than typed, and
//   * dwExtraInfo, a caller-supplied 64-bit field that travels with the event
//     through the whole input stack.
//
// So every event the operator emits is stamped with a unique sentinel in
// dwExtraInfo, and the hook classifies an event as the operator's ONLY when that
// sentinel is present. Everything else is the human. The default is the safe one:
// anything the operator cannot prove it sent is treated as a takeover.
//
// A consequence worth stating: operator input is moved from SetCursorPos and
// mouse_event to SendInput, because only SendInput carries dwExtraInfo. Without
// that change the cursor moves would be untagged and every one of them would look
// like a human takeover.
//
// THE STATE IS AUTHORITATIVE
//
// Guard.State is a single variable that both drives the visible indicator and gates
// every input endpoint. There is no second "displayed" state that could disagree
// with the real one, and no code path that injects input without reading it.

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
    public class Guard
    {
        // States. Held in one authoritative field; the indicator renders this and
        // the input endpoints test this, so they cannot drift apart.
        public const string OBSERVING = "OBSERVING";
        public const string ARMED = "ARMED";
        public const string WORKING = "WORKING";
        public const string HUMAN_TAKEOVER = "HUMAN_TAKEOVER";
        public const string PAUSED = "PAUSED";
        public const string RESUMING = "RESUMING";
        public const string EMERGENCY_STOP = "EMERGENCY_STOP";

        // Ownership sentinel. "PORTAIIM" in ASCII, as a 64-bit value. Any event
        // carrying exactly this in dwExtraInfo is provably ours.
        /// Ownership sentinel stamped on every event the operator injects, and the ONLY
        /// thing that distinguishes operator input from a human pressing a key.
        ///
        /// It used to be the fixed constant 0x504F52544149494D, which had two defects,
        /// both of them found by measuring rather than by reading:
        ///
        ///   1. The declaration cast through (int), so the value the guard actually
        ///      compared against was the truncated 0x4149494D. The "PORTAIIM" literal in
        ///      the source was never in use. Forgery tests that copied the source literal
        ///      were rejected for the wrong reason and produced a false PASS.
        ///
        ///   2. A constant is not a secret. It ships in the source, so any process that
        ///      can read this file can stamp it and have its injection credited to the
        ///      operator. This was measured, not assumed: an external process sending
        ///      dwExtraInfo = 0x4149494D was counted as operator input (operator 0 -> 4).
        ///
        /// It is now a random 64-bit value generated per host start with
        /// RandomNumberGenerator, and it is deliberately NOT published in any endpoint.
        /// An attacker who can read the operator's own source still has the principle;
        /// what this removes is the free, no-privilege forgery. Note the limit honestly:
        /// this is same-user obscurity, not isolation. Closing it properly needs the
        /// guard in a separate process whose memory the automation layer cannot read,
        /// or a driver - neither of which is available without elevation, and both of
        /// which are recorded as the remaining work rather than claimed as done.
        public static readonly IntPtr Sentinel = NewSentinel();

        static IntPtr NewSentinel()
        {
            byte[] b = new byte[8];
            System.Security.Cryptography.RandomNumberGenerator.Create().GetBytes(b);
            // A sentinel of all-zero bytes would collide with dwExtraInfo = 0, which is
            // what an untagged injector sends, so it must never be zero.
            if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0 && b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == 0)
                b[7] = 1;
            long v = BitConverter.ToInt64(b, 0);
            return new IntPtr(v);
        }

        private static string state = OBSERVING;
        private static string reason = "initial";
        private static long seq = 0;
        private static long lastTakeoverAt = 0;
        private static readonly object gate = new object();

        // Emergency stop is a LATCH, not a state you fall out of. It is cleared only
        // by an explicit re-arm, so a stuck operator cannot drift back into typing.
        private static bool emergencyLatched = false;

        // The hook thread sees these.
        public static volatile bool takeoverPending = false;

        /// Set by the hook when the human physically presses Ctrl+Alt+R. Re-arming clears a
        /// human's emergency latch, so - like release - it must require an untagged key event
        /// that the operator cannot manufacture.
        public static volatile bool rearmPending = false;
        public static volatile bool emergencyPending = false;
        public static volatile bool releasePending = false;
        public static volatile bool observeTogglePending = false;

        public static long HumanEvents = 0;

        /// WHY THIS EXISTS
        ///
        /// SetWindowsHookEx used to be called and its result discarded. The HTTP gate refused
        /// injection regardless, so every automated safety test passed while no keyboard hook
        /// existed at all - and the reserved chords went straight to the human's desktop.
        ///
        /// A human who presses the documented release chord and watches an unrelated window
        /// open has discovered something no test suite can, and the correct response is to
        /// make the precondition impossible to miss: if the hook is not installed, the
        /// operator refuses to inject AND says why, instead of failing silently.
        public static volatile string hookUnhealthy = null;

        public static string HookUnhealthy { get { lock (gate) { return hookUnhealthy; } } }

        public static void SetHookUnhealthy(string why)
        {
            lock (gate) { hookUnhealthy = why; }
        }

        public static void ClearHookUnhealthy()
        {
            lock (gate) { hookUnhealthy = null; }
        }
        public static long OperatorEvents = 0;
        public static long OtherInjected = 0;

        public static string State { get { lock (gate) { return state; } } }
        public static string Reason { get { lock (gate) { return reason; } } }
        public static long Seq { get { lock (gate) { return seq; } } }
        public static bool EmergencyLatched { get { lock (gate) { return emergencyLatched; } } }
        public static bool TakeoverPending { get { lock (gate) { return takeoverPending; } } }
        public static long LastTakeoverAt { get { lock (gate) { return lastTakeoverAt; } } }

        private static void Set(string next, string why)
        {
            lock (gate)
            {
                if (state == next && why == reason) return;
                state = next; reason = why; seq++;
            }
        }

        /// May the operator inject input right now? This is the single gate every
        /// input endpoint consults. Observation is not enough; only ARMED and
        /// WORKING permit injection.
        public static bool MayInject()
        {
            lock (gate)
            {
                if (emergencyLatched) return false;
                if (takeoverPending) return false;
                // FAIL CLOSED when the hook is not installed.
                //
                // Injection is only meaningful while a hook can observe and interrupt it.
                // Without WH_KEYBOARD_LL the operator cannot tell a human keystroke from its
                // own, so it cannot honour a takeover - and the reserved chords leak to the
                // desktop. Injecting anyway would mean the guard was decorative.
                //
                // This check was absent, which is how the hook could fail silently while
                // every other test still passed.
                if (hookUnhealthy != null) return false;
                return state == ARMED || state == WORKING;
            }
        }

        public static string WhyRefused()
        {
            lock (gate)
            {
                if (emergencyLatched) return "EMERGENCY_STOP latched; an explicit re-arm is required";
                if (takeoverPending) return "human takeover detected; input suspended";
                return "state is " + state + "; the operator must be ARMED to inject input";
            }
        }

        /// EFFECTIVE INPUT PERMISSION - the answer to "may input happen right now?".
        ///
        /// This is deliberately separate from `State`, and the separation is the point.
        /// `State` is the CONTROL state: which mode the operator is in. `MayInject()` is the
        /// ENFORCEMENT result: whether a keystroke would actually be sent. They are genuinely
        /// different questions, and they legitimately disagree - a run observed
        /// `state: "ARMED"` together with `mayInject: false`, because a human takeover was
        /// pending while the control mode had not yet transitioned.
        ///
        /// That combination is not a bug in the gate; the gate was right and the *report* was
        /// ambiguous. A human reading a panel that says ARMED would reasonably conclude input
        /// is permitted, and would be wrong at exactly the moment it matters most.
        ///
        /// So the status is reported in three parts, and the headline can never read as
        /// "ARMED" on its own while input is blocked.
        public static string InputPermission
        {
            get { lock (gate) { return MayInjectLocked() ? "PERMITTED" : "BLOCKED"; } }
        }

        /// Why input is blocked, or null when it is permitted.
        public static string BlockingReason
        {
            get { lock (gate) { return MayInjectLocked() ? null : WhyRefusedLocked(); } }
        }

        /// A headline that cannot be misread.
        ///
        /// "ARMED" on its own is a statement about the control mode only. When input is in
        /// fact blocked, the headline says so: "ARMED / INPUT BLOCKED". There is no reading of
        /// this string in which a person concludes that input is flowing when it is not.
        public static string Headline
        {
            get
            {
                lock (gate)
                {
                    bool permitted = MayInjectLocked();
                    if (permitted) return state == WORKING ? "WORKING" : "ARMED";
                    // Emergency stop is a mode in its own right and needs no suffix to read
                    // correctly; the others genuinely are a control state with input blocked.
                    if (state == EMERGENCY_STOP) return "EMERGENCY STOP";
                    if (state == OBSERVING) return "OBSERVING";
                    return state + " / INPUT BLOCKED";
                }
            }
        }

        private static string WhyRefusedLocked()
        {
            if (emergencyLatched) return "EMERGENCY_STOP latched; an explicit re-arm is required";
            if (takeoverPending) return "human takeover detected; input suspended";
            if (hookUnhealthy != null) return hookUnhealthy;
            return "state is " + state + "; the operator must be ARMED to inject input";
        }

        public static void NoteOperatorEvent() { Interlocked.Increment(ref OperatorEvents); }
        public static void NoteHumanEvent() { Interlocked.Increment(ref HumanEvents); }
        public static void NoteOtherInjected() { Interlocked.Increment(ref OtherInjected); }

        /// A genuine human event was seen. Suspends immediately and does not resume
        /// on idle - recovery is always an explicit human decision.
        public static void HumanTakeover(string detail)
        {
            lock (gate)
            {
                takeoverPending = true;
                lastTakeoverAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            // An emergency stop must not be downgraded to a takeover.
            //
            // Pressing Ctrl+Alt+Esc also releases the modifier keys afterwards, and every one
            // of those keyups is a human keyboard event - so HumanTakeover ran a moment later
            // and overwrote EMERGENCY_STOP with HUMAN_TAKEOVER. Injection stayed blocked,
            // because the latch is a separate flag, so nothing unsafe happened.
            //
            // But the LABEL became the problem: the panel said "human takeover", which reads
            // as a recoverable pause, while the operator was in fact stopped and needed an
            // explicit re-arm. That is the same defect class as the ARMED-while-blocked
            // problem - a state name that understates how stuck things are - and it is
            // exactly what would mislead a human deciding whether to touch the machine.
            if (EmergencyLatched) return;
            Set(HUMAN_TAKEOVER, detail);
        }

        public static void EmergencyStop(string detail)
        {
            lock (gate) { emergencyLatched = true; }
            Set(EMERGENCY_STOP, detail);
        }

        /// Explicit release by the human. Never resumes prior work: it only moves the
        /// machine to RESUMING, and the caller must re-observe and re-plan.
        ///
        /// It also does NOTHING while an emergency stop is latched.
        ///
        /// This was a real bug, not a theoretical one. Release() unconditionally set
        /// RESUMING, so after an emergency stop the authoritative state field said
        /// "RESUMING" while emergencyLatched was still true. Injection stayed refused
        /// and only a re-arm could clear the latch, so the safety property held - but
        /// the state the operator and the indicator panel read and display had stopped
        /// saying EMERGENCY STOP. A status that stops reporting the condition it exists
        /// to report is a real defect, and it is exactly what a person at the desk would
        /// rely on to know why input is being refused.
        ///
        /// So the latch now outranks the release: the state stays EMERGENCY_STOP, the
        /// refusal reason says so, and the only way out remains an explicit re-arm.
        public static void Release(string detail)
        {
            lock (gate)
            {
                if (emergencyLatched)
                {
                    reason = "release refused: emergency stop is latched; an explicit re-arm is required (" + detail + ")";
                    return;
                }
                takeoverPending = false;
            }
            Set(RESUMING, detail);
        }

        /// Re-arm after an emergency stop. Still does not inject anything by itself.
        public static void Rearm(string detail)
        {
            lock (gate) { emergencyLatched = false; takeoverPending = false; }
            Set(ARMED, detail);
        }

        public static void Pause(string detail) { Set(PAUSED, detail); }
        public static void Observe(string detail) { Set(OBSERVING, detail); }
        public static void Arm(string detail) { Set(ARMED, detail); }
        public static void Working() { if (MayInject()) Set(WORKING, "performing an action"); }

        public static string Json()
        {
            lock (gate)
            {
                return "{\"state\":\"" + state + "\",\"reason\":\"" + Escape(reason)
                    + "\",\"seq\":" + seq
                    + ",\"mayInject\":" + (MayInjectLocked() ? "true" : "false")
                    // Reported separately from `state` because they are different questions,
                    // and a run was observed with state ARMED and mayInject false. Anything
                    // gating on `state` alone would have injected into a human takeover.
                    + ",\"inputPermission\":\"" + (MayInjectLocked() ? "PERMITTED" : "BLOCKED") + "\""
                    + ",\"blockingReason\":" + (MayInjectLocked() ? "null" : "\"" + Escape(WhyRefusedLocked()) + "\"")
                    + ",\"headline\":\"" + Escape(Headline) + "\""
                    + ",\"emergencyLatched\":" + (emergencyLatched ? "true" : "false")
                    + ",\"takeoverPending\":" + (takeoverPending ? "true" : "false")
                    + ",\"lastTakeoverAt\":" + lastTakeoverAt
                    + ",\"humanEvents\":" + HumanEvents
                    + ",\"operatorEvents\":" + OperatorEvents
                    + ",\"otherInjected\":" + OtherInjected
                    // The sentinel itself is deliberately NOT reported here. It used to be
                    // published in this JSON, which handed every client - including the
                    // automation layer - the exact value needed to have its injection
                    // credited to the operator. An empty string is reported instead so
                    // that its absence is visible rather than silently missing.
                    + ",\"sentinel\":\"\"}";
            }
        }

        private static bool MayInjectLocked()
        {
            if (emergencyLatched || takeoverPending) return false;
            return state == ARMED || state == WORKING;
        }

        private static string Escape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", " ");
        }
    }
}
