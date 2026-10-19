#!/usr/bin/env python3
"""
GRAMMAR UNIT CONTROLS. Structural only - no model, no socket, no AIOS code.

Run: python packages/model/local/test-grammar.py

=============================================================================
WHAT THIS FILE IS FOR
=============================================================================

A grammar is only trustworthy if its REFUSALS are tested as carefully as its acceptances, and if
both directions are known to be reachable. A control that cannot fail is not a control, so this file
contains:

  * cases the grammar MUST accept, including ones with nonsense capability and tool names - because
    the grammar must NOT be deciding those
  * cases it MUST reject, for structural reasons only
  * NEGATIVE CONTROLS: assertions that each check can fail, so a passing run means something

=============================================================================
THE ASSERTION THAT MATTERS MOST
=============================================================================

The grammar accepts `capability: "filesystem.telepathy"` and `tool: "rm-rf-everything"` without
complaint. That is not a gap in the grammar - it is the design. If the grammar filtered those, the
compiler's capability check and the router's tool check would be UNREACHABLE, and the only thing
standing between a model and this computer would be a string matcher.

So `test_grammar_does_not_filter_semantics` asserts the grammar's PERMEISSIVENESS, and it would fail
the moment someone helpfully added the real capability list to it. Making it fail is the point.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grammar import PlanGrammar, DEPTH_CAP, ARRAY_CAP  # noqa: E402

CHECKS: list[tuple[bool, str]] = []


def check(ok: bool, msg: str) -> None:
    CHECKS.append((bool(ok), msg))


def step(**over) -> dict:
    """A structurally complete step, so tests can vary exactly one field."""
    s = {
        "id": "a",
        "capability": "filesystem.inspect",
        "intent": "look",
        "mode": "filesystem",
        "tool": "inspect-folder",
        "args": {"path": "C:\\x"},
        "dependsOn": [],
        "rationale": "why",
        "verification": {"kind": "must-exist", "description": "d"},
        "onFailure": "replan",
    }
    s.update(over)
    return s


def plan(steps=None, **root) -> str:
    p = {"constraints": [], "steps": [step()] if steps is None else steps, "expectedResult": "e"}
    p.update(root)
    return json.dumps(p)


def accepts(text: str) -> bool:
    g = PlanGrammar()
    s = g.feed(g.start(), text)
    return s is not None and g.complete(s)


def rejects(text: str) -> bool:
    return not accepts(text)


# ============================================================================================
# ACCEPT: valid documents, including semantically nonsense ones
# ============================================================================================

check(accepts('{"refusal":"cannot"}'), "ACCEPT a minimal refusal")
check(accepts(plan()), "ACCEPT a complete one-step plan")
check(accepts(plan([step(capability="anything.at.all", tool="rm-rf-everything", mode="cli")])),
      "ACCEPT a step naming a nonexistent capability AND tool (the grammar must not judge these)")
check(accepts(plan([step(dependsOn=["nope", "also-nope"])])), "ACCEPT a dangling dependency (compiler's job)")
_deep_args = {"deep": {"deeper": {"deepest": {"a": [1, 2, {"b": None}]}}}}
check(accepts(plan([step(args=_deep_args)])),
      "ACCEPT arbitrarily-shaped free-form args")
check(accepts(plan([step(effect={"kind": "delete", "target": "C:\\", "reason": "r", "irreversible": True})])),
      "ACCEPT a declared delete effect (governance's job)")
check(accepts(plan([step(args={})])), "ACCEPT an empty args object")

# keys in any order - the grammar must not force an order
_reordered = json.dumps({"expectedResult": "e", "steps": [step()], "constraints": []})
check(accepts(_reordered), "ACCEPT top-level keys in a different order")

# ============================================================================================
# REJECT: structural failures only
# ============================================================================================

check(rejects("Sure! Here is your plan."), "REJECT prose")
check(rejects('{"refusal":"x"'), "REJECT an unterminated object")
check(rejects('{"refusal":"a",}'), "REJECT a trailing comma")
check(rejects("{'refusal':'a'}"), "REJECT single quotes")
check(rejects('{"refusal":"a","refusal":"b"}'), "REJECT a duplicate key")
check(rejects('{"notAField":1}'), "REJECT an unknown top-level field")
check(rejects(plan([step(mode="shell")])), "REJECT an invalid mode value")
check(rejects(plan([step(onFailure="explode")])), "REJECT an invalid onFailure value")
check(rejects(plan([step(verification={"kind": "trust-me", "description": "d"})])),
      "REJECT an invalid verification kind")
check(rejects(plan([step(verification={"description": "d"})])), "REJECT a verification missing its kind")
check(rejects(plan([{"id": "a", "capability": "x", "intent": "i", "mode": "cli", "tool": "t",
                    "args": {}, "dependsOn": [], "rationale": "r", "onFailure": "replan"}])),
      "REJECT a step missing a required field (this is what makes the grammar's guarantee real)")
check(rejects(plan(["not-an-object"])), "REJECT a step that is a bare string")
check(rejects('{"constraints":["unclosed","steps":['), "REJECT unbalanced input")
check(rejects('{"steps":["do it"],"expectedResult":"e"}'), "REJECT an array of strings where steps go")

# malformed numbers, in a genuinely free slot
for bad in ("1.2.3", "1.", "1e", "-", "1..2", "1e+"):
    _t = plan([step(args={"n": 0})]).replace('"n": 0', '"n": ' + bad)
    check(rejects(_t), f"REJECT the malformed number {bad}")

# well-formed numbers must be accepted
for good in ("-5", "1.5", "0", "1e3", "1.5e-3"):
    _t = plan([step(args={"n": 0})]).replace('"n": 0', '"n": ' + good)
    check(accepts(_t), f"ACCEPT the well-formed number {good}")

# bounds
_too_deep: object = "x"
for _ in range(DEPTH_CAP + 5):
    _too_deep = {"a": _too_deep}
check(rejects(plan([step(args=_too_deep)])), f"REJECT nesting deeper than the cap ({DEPTH_CAP})")
check(accepts(plan([step(args={"a": {"b": {"c": 1}}})])), "ACCEPT nesting well within the cap")
_too_many = [{"n": i} for i in range(ARRAY_CAP + 4)]
check(rejects(plan([step(args=_too_many)])), f"REJECT an array longer than the cap ({ARRAY_CAP})")
check(rejects(plan([step(intent="x" * 500)])), "REJECT a string longer than the cap")

# ============================================================================================
# THE ASSERTION THAT MATTERS MOST
# ============================================================================================

def test_grammar_does_not_filter_semantics() -> None:
    """
    The grammar must NOT know which capabilities or tools exist.

    If it did, the compiler's `isCapability` check and the router's tool lookup would become
    unreachable code, and a plan naming a nonexistent capability would die in the GRAMMAR rather than
    in the place whose job is to judge it. The refusal would still be correct - but it would be the
    wrong refusal, in the wrong layer, with no audit trail through the compiler that explains why.
    """
    g = PlanGrammar()
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "grammar.py"), encoding="utf-8").read()

    # The real capability vocabulary must not appear as a grammar enum.
    for cap in ("filesystem.inspect", "filesystem.transform", "terminal.run", "filesystem.write"):
        check(cap not in src, f"the grammar must not embed the capability name {cap}")
    for tool in ("inspect-folder", "compose-summary", "run-process", "write-summary"):
        check(tool not in src, f"the grammar must not embed the tool name {tool}")

    # And it must accept a plan full of nonsense names.
    bogus = plan([step(capability="totally.made.up", tool="definitely-not-registered",
                       dependsOn=["ghost"], intent="i", mode="cli",
                       effect={"kind": "delete", "target": "C:\\everything",
                               "reason": "the model felt like it", "irreversible": True})])
    check(accepts(bogus), "the grammar accepts a semantically absurd plan - so the validators must be what reject it")

    # capability and tool are declared as plain STR in the schema
    check('"capability": (STR,)' in src, "capability is declared as a free string")
    check('"tool": (STR,)' in src, "tool is declared as a free string")
    check('"args": (FREE,)' in src, "args is declared free-form")


test_grammar_does_not_filter_semantics()


# ============================================================================================
# NEGATIVE CONTROLS - a passing run must mean something
# ============================================================================================

def test_repeated_trials_from_one_state_do_not_corrupt_it() -> None:
    """
    The decode loop tries MANY candidate tokens from ONE state. A feed that mutated its input would
    make the second candidate fail because the first had already advanced it.

    This is the control that catches it, and it was missing: every other test started from a fresh
    state, so the whole suite passed while constrained generation aborted on its first token. The
    symptom was a 500 - "every permitted token was rejected" - on a state that was plainly valid.
    """
    g = PlanGrammar()
    s = g.start()
    good = g.feed(s, '{"constraints":')
    check(good is not None, "TRIAL: the prefix advances")

    # The same state, many times, interleaved with candidates that FAIL.
    #
    # Probed from a state where BOTH outcomes are meaningful. The first version probed from the initial
    # state, where `[]` is correctly rejected - so the "must succeed" half was asserting something false,
    # and the control failed for a reason that had nothing to do with the bug it was written to catch.
    mid = g.feed(g.start(), '{"constraints":')
    check(mid is not None, "TRIAL: the mid-document prefix advances")
    results = []
    for _ in range(5):
        results.append(g.feed(mid, "[]") is not None)      # succeeds
        results.append(g.feed(mid, "}}") is None)          # fails, must not damage the state
        results.append(g.feed(mid, "[]") is not None)      # must still succeed
    check(all(results), "TRIAL: repeated trials from one state are independent (no state corruption)")

    # And the specific case that broke it: try candidates in ranked order, the way the mask does.
    s2 = g.start()
    accepted_any = False
    for piece in ["{" + chr(92), "{-", chr(123) + chr(34), "{:"]:
        if g.feed(s2, piece) is not None:
            accepted_any = True
    check(accepted_any, "TRIAL: a rejected candidate does not poison the ones after it")

    # Finally: the bare brace must be accepted from the initial state.
    check(g.feed(s2, "{") is not None, "TRIAL: a bare '{' is accepted from the initial state")


test_repeated_trials_from_one_state_do_not_corrupt_it()


def test_dead_prefix_is_refused_not_deadlocked() -> None:
    """
    THE M10 DEADLOCK, as a regression control.

    Measured failure: the model emitted the key prefix `outputFilePathCSharpCodeExample123456789` -
    40 characters, hitting the key-length cap, and a prefix of no field in the schema. From that state
    ZERO of 34,192 candidate tokens were acceptable, so `server.py` raised `GrammarExhausted` and the
    request returned HTTP 500.

    That is a denial of service on whoever asked for a plan: they wait, then get an error instead of a
    refusal. A constrained decoder that can wedge is worse than one that declines.

    The fix is key PREFIX VIABILITY - the mask may only offer characters that keep the buffer a prefix
    of a real, still-unused field name - so a dead prefix is never enterable in the first place.

    The two halves matter separately:
      * the mask must not ENTER the dead prefix  (else the deadlock is reachable)
      * the mask must not WEDGE once there       (else it still aborts rather than refusing)
    """
    g = PlanGrammar()

    dead = "outputFilePathCSharpCodeExample123456789"     # the exact prefix the model produced

    # (a) The dead prefix is not reachable: every character is refused at the point of divergence.
    st = g.start()
    for ch in '{"':
        st = g._char(st, ch)
    allowed = g.allowed_bytes(st)
    check(ord("o") not in allowed,
          "DEADLOCK: the mask refuses the first character of the prefix that caused the M10 wedge")

    st = g.feed(g.start(), '{"o')
    check(st is None, "DEADLOCK: feeding the dead prefix is refused, not accepted")

    # (b) Every character of it is refused somewhere along the way.
    accepted_prefix = ""
    for n in range(1, len(dead) + 1):
        s = g.feed(g.start(), '{"' + dead[:n])
        if s is None:
            break
        accepted_prefix = dead[:n]
    check(len(accepted_prefix) < len(dead),
          f"DEADLOCK: the dead prefix cannot be typed in full (accepted only {len(accepted_prefix)} "
          f"of {len(dead)} chars before the grammar refused)")

    # (c) Where it does stop, the state is a REFUSAL - no legal continuation, EOS withheld - rather
    #     than a state that can absorb arbitrary text.
    if accepted_prefix:
        s = g.feed(g.start(), '{"' + accepted_prefix)
        legal = g.allowed_bytes(s)
        conts = [c for c in legal if not chr(c).isspace()]
        # Only the closing quote and the object close may remain, and neither extends the key.
        check(all(chr(c) in (chr(34), "}") for c in conts),
              "DEADLOCK: a wedged key state offers only a close, never another key character")
        check(not g.accepts_eos(s), "DEADLOCK: EOS is withheld at a wedged state")

    # (d) A genuinely dead state must still be terminal rather than accepting junk.
    check(rejects('{"outputFilePath": 1}'),
          "DEADLOCK: a document using an unknown root field is refused outright")

    # (e) The control can fail: a real key prefix IS still enterable, so (a)-(d) are not vacuous.
    check(g.feed(g.start(), '{"con') is not None,
          "DEADLOCK: the control is not vacuous - a valid key prefix is still accepted")


test_dead_prefix_is_refused_not_deadlocked()


def test_no_state_can_wedge() -> None:
    """
    EVERY reachable state must have at least one legal continuation, or constrained generation can
    deadlock instead of refusing.

    Found by measurement, twice, and both times it was the MASK disagreeing with the character machine
    rather than the grammar being wrong about the document:

      1. `IN_KEY` offered any letter, so the key buffer could reach a prefix of no field - the
         `outputFilePathCSharpCodeExample123456789` case, where 0 of 34,192 tokens were acceptable.
      2. `IN_NUM` withheld the delimiters that terminate a number, so once `num_buf` hit its cap the
         only permitted bytes were whitespace - and no token in a byte-level vocabulary starts with a
         bare space. A 24-character number wedged the machine for good.

    A wedge is far worse than a refusal: the caller waits out the whole timeout and then gets an
    infrastructure error instead of an answer.

    This control walks a realistic document and asserts that no state along the way is a dead end. It
    is a property of the MASK, not of the parser, which is why it does not duplicate the accept/reject
    tests above.
    """
    g = PlanGrammar()
    docs = [
        plan(),
        plan([step(args={"n": 0, "deep": {"a": [1, -2.5e-3, True, None]}})]),
        plan([step(mode="cli", tool="t", capability="x",
                   verification={"kind": "must-read-back", "description": "d"},
                   effect={"kind": "install", "target": "t", "reason": "r", "irreversible": False})]),
    ]
    dead = []
    for d in docs:
        st = g.start()
        for ch in d:
            allowed = g.allowed_bytes(st)
            # Whitespace is always permitted but no real token is whitespace-initial in a byte-level
            # vocabulary, so it does not count as a live continuation.
            if not [b for b in allowed if not chr(b).isspace()] and not g.accepts_eos(st):
                dead.append((ch, st.mode))
                break
            nxt = g._char(st, ch)
            if nxt is None:
                break
            st = nxt
    check(not dead, f"WEDGE: no state on a valid document is a dead end (found {dead[:3]})")

    # The specific number case, which is what actually bit.
    #
    # Built from a REAL prefix that reaches a free-form slot. An earlier version put the `{` on
    # `refusal`, which is a STRING field, so the probe was rejected before it reached any number and the
    # assertions never ran - the control was silently testing nothing.
    prefix = '{"constraints":[],"steps":[{"id":"a","capability":"x","intent":"i","mode":"cli",' \
             '"tool":"t","args":{"n":'
    st = g.start()
    for ch in prefix:
        st = g._char(st, ch)
    check(st is not None, "WEDGE: the prefix reaching a free-form number slot is itself valid")
    if st is not None:
        for ch in "1234567890123456789012345678":     # 28 digits, past the cap
            # Stop at the FIRST refusal - whether it arrives as None or as a failed state. An earlier
            # version ran to the end of the digits, so the failed state it had correctly produced was
            # overwritten by None on the next character and the control reported a failure that had
            # already been avoided.
            if st is None or st.failed:
                break
            st = g._char(st, ch)
        # At the cap the grammar must make a DECISION, not stall: either the number was still
        # acceptable, or the document is refused outright. Both are correct outcomes; disagreeing
        # with itself mid-value is not, because which half governed then depended on how the text
        # arrived.
        check(st is not None and st.failed,
              "WEDGE: a number past its cap fails the document outright rather than stalling")
        check(st is None or not [b for b in g.allowed_bytes(st) if not chr(b).isspace()],
              "WEDGE: a failed state offers no continuation, so the decoder stops instead of wedging")

    # And the negative control: this control is not vacuous - a genuinely finished document is terminal.
    check(g.complete(g.feed(g.start(), '{"refusal":"x"}')),
          "WEDGE: the control is not vacuous - a complete document is recognised as one")


test_no_state_can_wedge()


def test_negatives() -> None:
    g = PlanGrammar()

    # 1. The reject predicate can reject.
    check(rejects("nonsense"), "NEGATIVE: the reject predicate detects genuinely invalid input")

    # 2. The accept predicate is not vacuously true.
    check(not accepts('{"refusal":"unterminated'), "NEGATIVE: an incomplete document is not 'accepted'")

    # 3. Completeness is distinct from acceptance: a truncated prefix is still VALID to continue from,
    #    which is what incremental decoding needs - but it can never be EMITTED as finished.
    s = g.feed(g.start(), '{"refusal":"x"')
    check(s is not None, "NEGATIVE: a truncated prefix remains valid to continue from")
    check(not g.complete(s), "NEGATIVE: ...and is not complete")
    check(not g.accepts_eos(s), "NEGATIVE: ...and EOS is refused there, so truncation cannot be emitted")

    s2 = g.feed(g.start(), '{"refusal":"x"}')
    check(g.accepts_eos(s2), "NEGATIVE: EOS IS allowed at a complete document")

    # 4. Every branch the machine relies on is reachable. A grammar with a dead branch is a grammar
    #    whose guarantees are partly untested.
    #
    #    OBJ_START is deliberately absent from this list: it is the INITIAL state and is consumed by the
    #    very first `{`, so it cannot appear in a post-character state set. The first version of this
    #    control asserted it was, which is an impossible claim about the machine - and a control that
    #    asserts something impossible is worse than no control, because it cannot ever pass and gets
    #    deleted rather than understood.
    modes_hit = set()
    # A document containing a bool and a number, so the LITERAL and IN_NUM branches are genuinely
    # reachable. `args` is free-form, so both are legal operands.
    text = plan([step(args={"flag": True, "count": 42, "nested": {"a": [1]}}, dependsOn=["d"])])
    st = g.start()
    for ch in text:
        st = g._char(st, ch)
        if st is None:
            check(False, "NEGATIVE: the branch-coverage document must itself be accepted")
            break
        modes_hit.add(st.mode)
    for needed in ("KEY_OR_END", "IN_KEY", "COLON", "VALUE", "IN_STR",
                   "IN_NUM", "AFTER_VALUE", "LITERAL"):
        check(needed in modes_hit, f"NEGATIVE: the {needed} branch is exercised by a real document")

    # 5. allowed_bytes must both permit and forbid, or the mask is decorative.
    #
    #    This control has now been wrong twice, in opposite directions, and both versions are worth
    #    recording because a control that encodes a misreading of the machine trains you to distrust
    #    the whole suite:
    #
    #      v1 asserted a LETTER was forbidden right after the opening quote. Backwards - after `"` the
    #         machine is reading a key, so letters are what is wanted.
    #      v2 asserted any letter (`a`) was permitted. Correct while the key mask was unconstrained,
    #         but it ENCODED THE BUG that caused the M10 deadlock: permitting `a` at the root is how
    #         the key buffer wanders to a prefix of no field, from which nothing can complete.
    #
    #    The rule is narrower than either, and is what is asserted now: the permitted letters are
    #    exactly those that keep the buffer a prefix of a real field name.
    st = g.start()
    st = g._char(st, "{")
    st = g._char(st, chr(34))          # now reading a key
    allowed = g.allowed_bytes(st)
    check(ord(chr(34)) in allowed, "NEGATIVE: allowed_bytes permits the key-closing quote")
    check(ord("!") not in allowed, "NEGATIVE: allowed_bytes forbids a character no key may contain")

    # The root fields are constraints / steps / expectedResult / refusal, so their initials are
    # exactly {c, s, e, r}. Anything else must be refused.
    check(ord("c") in allowed, "NEGATIVE: a real field initial is permitted (c for constraints)")
    check(ord("z") not in allowed, "NEGATIVE: a letter that begins no field is refused (z)")
    check(ord("a") not in allowed, "NEGATIVE: a letter that begins no field is refused (a)")

    # And narrowing must not be so tight that a real key cannot be typed.
    for real in ("constraints", "steps", "expectedResult", "refusal"):
        st2 = g.feed(g.start(), '{"' + real)
        ok = st2 is not None and ord(chr(34)) in g.allowed_bytes(st2)
        check(ok, f"NEGATIVE: prefix viability still allows the real key {real!r}")

    # And after a colon, only a value may begin - a stray letter must be forbidden.
    #
    # Built from a REAL document prefix rather than an invented one. The first version used `{"args"`,
    # which is not a valid prefix of any plan - `args` is a step field, not a root field - so the probe
    # was rejected before it reached the colon and the assertions never ran.
    st2 = g.start()
    _ok = True
    for ch in '{"constraints":[],"steps":[{"args"':
        st2 = g._char(st2, ch)
        if st2 is None:
            _ok = False
            break
    check(_ok, "NEGATIVE: the probe prefix for the colon state is itself valid")
    if _ok:
        st2 = g._char(st2, ":")
        allowed2 = g.allowed_bytes(st2)
        check(ord("{") in allowed2 and ord(chr(34)) in allowed2,
              "NEGATIVE: allowed_bytes permits a value to begin after a colon")
        check(ord("z") not in allowed2, "NEGATIVE: allowed_bytes forbids a bare letter where a value is due")


test_negatives()


# ============================================================================================
# NON-EMPTY `steps` - the grammar and the parser must agree about what a plan IS
# ============================================================================================

def test_non_empty_steps() -> None:
    # ---------------------------------------------------------------- the machine
    check(rejects('{"steps":[]}'),
          "NEGATIVE: an empty steps array is REJECTED, because parse.ts rejects it")
    check(rejects('{"constraints":[],"steps":[],"expectedResult":"e"}'),
          "NEGATIVE: a fully-formed plan carrying zero steps is REJECTED")
    check(rejects('{"steps":[ ]}'),
          "NEGATIVE: whitespace does not smuggle an empty steps array past the rule")

    # ---------------------------------------------------------------- the mask
    # The character machine and the mask must agree. If only the machine refused, constrained
    # decoding would keep OFFERING the model a byte that always gets rejected, which presents as
    # "the grammar randomly fails" rather than as the rule it actually is.
    g = PlanGrammar()
    st = g.start()
    for ch in '{"steps":[':
        st = g._char(st, ch)
    ok = st is not None
    check(ok, "POSITIVE: the prefix {\"steps\":[ is itself inside the grammar")
    if ok:
        check(ord("]") not in g.allowed_bytes(st),
              "NEGATIVE: the mask does not offer ']' immediately inside steps")
        check(ord("{") in g.allowed_bytes(st),
              "POSITIVE: the mask still offers '{' so a first step can begin")

    # ---------------------------------------------------------------- no collateral damage
    # `dependsOn: []` is the ordinary first step. An earlier grammar refused it, which made the most
    # common field in the schema the one thing it could not express. That must not regress.
    #
    # The opening bracket matters: until `[` is consumed the top frame is still the step OBJECT and
    # `]` is not offered, because the value has not begun. Probing one character early reads as a
    # regression that is not there.
    g2 = PlanGrammar()
    st2 = g2.start()
    for ch in '{"steps":[{"dependsOn":[':
        st2 = g2._char(st2, ch)
    ok2 = st2 is not None
    check(ok2, "POSITIVE: a step may open its dependsOn array")
    if ok2:
        check(st2.stack[-1].open_key == "dependsOn",
              "POSITIVE: the dependsOn array is keyed by its own name, not by 'steps'")
        check(ord("]") in g2.allowed_bytes(st2),
              "REGRESSION: dependsOn may still be empty - only steps is constrained")
        check(g2._char(st2, "]") is not None,
              "REGRESSION: an empty dependsOn array really does close")

    # `constraints` and `refusal` are untouched by the rule.
    check(accepts('{"constraints":[],"refusal":"cannot"}'),
          "REGRESSION: a refusal-only plan with an empty constraints array is still accepted")
    check(accepts(plan([step()])), "POSITIVE: a plan with ONE structurally valid step is accepted")
    check(accepts(plan([step(id="a"), step(id="b")])),
          "POSITIVE: a plan with two structurally valid steps is accepted")


test_non_empty_steps()


# ============================================================================================
# OPTIONAL FIELDS LAST - the dead end the 0.5B walked into, twice
# ============================================================================================

def test_optional_fields_are_offered_last() -> None:
    """
    A model emitted `effect` before the required fields were finished and could not escape: `effect`
    completed, `}` was the only legal byte, closing the step was illegal, and no required key was on
    offer. Generation aborted after 610 rejected candidates. The requirement was real - four required
    fields WERE still missing - so the fix is the ORDER in which keys are offered, not the rule.
    """
    from grammar import ROOT_SCHEMA

    g = PlanGrammar()
    st = g.start()
    prefix = '{"steps":[{"id":"a","capability":"filesystem.inspect"'
    for ch in prefix:
        st = g._char(st, ch)
    check(st is not None, "POSITIVE: a partially filled step is a legal prefix")

    if st is not None:
        viable = g._key_viable(st)
        step_schema = ROOT_SCHEMA["fields"]["steps"][1][1]
        seen = st.stack[-1].seen
        required_left = [k for k in step_schema["required"] if k not in seen]
        check(len(required_left) > 0, "the control state really does still owe required fields")
        check("effect" not in viable,
              "NEGATIVE: the optional 'effect' key is NOT offered while required fields remain")
        check(all(k in viable for k in required_left),
              "POSITIVE: every still-required key IS offered - the rule is deferred, not tightened")

    # Once every required field is present, `effect` becomes available again. The closing brace is
    # withheld deliberately: feeding it would pop the step frame and leave the top of the stack
    # holding the ARRAY, so there would be no step object left to ask about.
    st3 = g.start()
    for ch in '{"steps":[' + json.dumps(step())[:-1]:
        st3 = g._char(st3, ch)
    check(st3 is not None and st3.stack[-1].kind == "obj",
          "POSITIVE: a step with every required field present is still an open object")
    if st3 is not None:
        check(g._can_close(st3.stack[-1]),
              "POSITIVE: a step with every required field present may close")
        check("effect" in g._key_viable(st3),
              "POSITIVE: the optional 'effect' key IS offered once every required field is present")

    check(accepts(plan([step(effect={"kind": "delete", "target": "t",
                                     "reason": "r", "irreversible": False})])),
          "POSITIVE: a step whose effect comes last is accepted end to end")

    # An effect FIRST is now refused, rather than accepted into a state that cannot be escaped.
    st4 = g.start()
    dead = False
    for ch in '{"steps":[{"effect":{"kind":"delete","target":"t","reason":"r","irreversible":false},"id":"a"':
        st4 = g._char(st4, ch)
        if st4 is None:
            dead = True
            break
    check(dead, "NEGATIVE: an effect emitted BEFORE the required fields is refused outright")


test_optional_fields_are_offered_last()


# ============================================================================================
# FREE-FORM `args`: CHECKABLE, NOT RESTRICTED
#
# The vocabulary of a free object stays OPEN - the tool owns its operands, not this grammar. What is
# refused is the two things that make an object impossible to CHECK: a duplicated key, and a copy of
# the step's own field name pretending to be an operand.
# ============================================================================================

def test_free_form_args_invariants() -> None:
    from grammar import RESERVED_STEP_KEYS

    def with_args(body: str) -> str:
        # Built as TEXT, not as a Python dict. `json.loads` silently collapses a duplicated key, so
        # round-tripping through one would make this whole test incapable of failing - and a control
        # that cannot fail is not a control.
        #
        # Compact separators, because that is the form the model emits and the form the grammar sees
        # between tokens; the default `", "` spacing would not match the dump the head is sliced from.
        s = json.dumps(step(), separators=(",", ":"))
        head = '{"id":"a","capability":"filesystem.inspect","intent":"look","mode":"filesystem",' \
               '"tool":"inspect-folder","args":'
        tail = ',"dependsOn":[],"rationale":"why",' \
               '"verification":{"kind":"must-exist","description":"d"},"onFailure":"replan"}'
        assert s.startswith(head) and s.endswith(tail), f"the step shape changed; fix this helper: {s}"
        return '{"steps":[' + head + body + tail + '],"expectedResult":"e"}'

    check(accepts(with_args('{"path":"C:/x","name":"n"}')),
          "POSITIVE: ordinary operands in args are accepted")
    check(accepts(with_args('{"deep":{"deeper":{"x":[1,2]}}}')),
          "POSITIVE: deeply nested operands are accepted")
    check(accepts(with_args('{"count":42,"nested":{"a":[1]},"flag":true}')),
          "POSITIVE: operands whose names begin like reserved fields are accepted")
    check(accepts(with_args('{"c":1}')),
          "REGRESSION: a one-letter operand is not blocked by `capability` starting with 'c'")

    # A duplicate key has two defensible readings and no standard resolution, so it cannot be checked.
    check(rejects(with_args('{"path":"C:/x","path":"C:/y"}')),
          "NEGATIVE: a DUPLICATE key inside args is rejected")
    check(rejects(with_args('{"a":1,"b":2,"a":3}')),
          "NEGATIVE: a duplicate key is rejected however far apart it is")
    check(accepts(with_args('{"a":1,"b":{"a":2}}')),
          "REGRESSION: the same key name in a NESTED object is a different key, and is allowed")

    # The step's own fields belong to the step. MEASURED: the model wrote `dependsOn`, `rationale`,
    # `verification`, `expectedResult` and `onFailure` inside `args`, three times over.
    for reserved in sorted(RESERVED_STEP_KEYS):
        check(rejects(with_args('{"%s":"x"}' % reserved)),
              f"NEGATIVE: the step field '{reserved}' may not appear inside args")

    check(accepts(plan([step()])),
          "REGRESSION: an ordinary one-step plan is still accepted")


test_free_form_args_invariants()


# ============================================================================================

def main() -> int:
    passed = sum(1 for ok, _ in CHECKS if ok)
    for ok, msg in CHECKS:
        print(f"  {'PASS' if ok else 'FAIL'}  {msg}")
    print()
    print(f"=== {passed}/{len(CHECKS)} grammar controls ===")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
