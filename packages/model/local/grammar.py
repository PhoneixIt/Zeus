r"""
CONSTRAINED GENERATION: a structural grammar for PlanProposal.

=============================================================================
WHAT THIS FILE IS, AND WHAT IT IS NOT
=============================================================================

This is a GRAMMAR. It constrains the SHAPE of the text a model may emit, and nothing else.

It guarantees, and only these:

  * valid JSON - balanced objects, arrays, strings, numbers, literals
  * the required fields are present, and each appears exactly once
  * field TYPES - a string where a string belongs, an array where an array belongs
  * closed string UNIONS that are facts about the FORMAT
  * key names are kept on a VIABLE prefix, so the machine cannot walk into a dead end
  * bounded depth, bounded string length, bounded array length
  * termination - only a complete document may be stopped at

It does NOT decide, and CANNOT decide, anything about safety:

  * whether a tool exists             -> the ROUTER
  * whether a verifier is registered  -> the router/verifier dispatch
  * whether a dependency is valid     -> the COMPILER
  * whether a target is current       -> the FRESHNESS contract
  * whether an effect is consequential-> the EXECUTOR's effect gate
  * whether approval exists           -> the APPROVAL STORE
  * whether an action is safe         -> GOVERNANCE

=============================================================================
THE RULE THIS FILE EXISTS TO KEEP
=============================================================================

    THE GRAMMAR MAY CONSTRAIN SYNTAX. IT MUST NEVER REPLACE SEMANTIC VALIDATION.

The tempting failure is to keep tightening this grammar until the model's plans
pass everything, because a grammar is far easier to make pass than a validator.
That would build a system where the only thing between a model and this computer
is a string matcher written to make a metric look good.

So three deliberate choices make this grammar WEAKER than it could be:

  1. `capability` is a FREE STRING. The real vocabulary is known and could be an
     enum here. It is not, because listing it would make the grammar - not the
     compiler - decide which capabilities exist, and the compiler's check must
     stay reachable.

  2. `tool` is a FREE STRING, for the same reason: tool existence is the ROUTER's
     question, and a grammar that pre-filters tool names makes the router's
     refusal unreachable.

  3. `args` is a FREE-FORM object with completely unconstrained keys and values.
     A step's operands are the TOOL's business. Encoding one tool's expectations
     here would put tool knowledge in a layer that must not know tools exist.

All three make the grammar easier to satisfy and the system harder to fool. That
is the correct direction. The grammar should never be the thing that makes you
feel safe.

=============================================================================
HOW IT WORKS
=============================================================================

An incremental character machine. `feed()` advances and returns None if the text
has left the grammar. `allowed_bytes()` reports which bytes may legally come
next, and the decode loop uses that set to MASK THE LOGITS - so a forbidden byte
is unreachable rather than merely rejected afterwards.

Object keys may appear in ANY order. That is deliberate: forcing an order would
constrain far more than structure, and real models emit keys in varying orders.
The grammar tracks which required keys have been seen and only closes an object
once every required one is present.
"""

from __future__ import annotations

# ---------------------------------------------------------------- the schema

# Closed string unions: facts about the FORMAT, not about safety. Note what is ABSENT.
MODE_VALUES = ("filesystem", "cli")
ON_FAILURE_VALUES = ("abort-mission", "continue", "replan")
VERIFICATION_KINDS = ("independent-source", "must-exist", "must-contain", "must-read-back")
EFFECT_KINDS = ("external-send", "purchase", "delete", "install", "credential-use", "security-setting")

STRING_CAP = 400
ARRAY_CAP = 12
# A DoS guard, not a style rule: `args` is free-form, so without a bound a model could emit arbitrarily
# deep nesting and make the parser itself the thing that runs out of memory. MEASURED at 5 this bound
# was too tight - it rejected a plan whose `args` legitimately nested three objects deep inside `steps`,
# which is exactly the shape a summariser's arguments have. 10 is comfortably above any real operand
# while still being a bound. Exceeding it is a REFUSAL, never a crash, and the test suite asserts
# that refusal.
DEPTH_CAP = 10

# Value-type tags.
STR, ENUM, BOOL, OBJ, ARR, FREE = "str", "enum", "bool", "obj", "arr", "free"

FREE_KEY = "\0free"      # sentinel: the current key is unknown because we are inside free-form


def _step_schema() -> dict:
    return {
        "required": ("id", "capability", "intent", "mode", "tool", "args",
                     "dependsOn", "rationale", "verification", "onFailure"),
        "optional": ("effect",),
        "fields": {
            "id": (STR,),
            "capability": (STR,),          # free ON PURPOSE - see module docstring
            "intent": (STR,),
            "mode": (ENUM, MODE_VALUES),
            "tool": (STR,),                # free ON PURPOSE
            "args": (FREE,),               # free ON PURPOSE
            "dependsOn": (ARR, (STR,)),
            "rationale": (STR,),
            "verification": (OBJ, {
                "required": ("kind", "description"),
                "optional": (),
                "fields": {"kind": (ENUM, VERIFICATION_KINDS), "description": (STR,)},
            }),
            "onFailure": (ENUM, ON_FAILURE_VALUES),
            "effect": (OBJ, {
                "required": ("kind", "target", "reason", "irreversible"),
                "optional": (),
                "fields": {
                    "kind": (ENUM, EFFECT_KINDS),
                    "target": (STR,),
                    "reason": (STR,),
                    "irreversible": (BOOL,),
                },
            }),
        },
    }


ROOT_SCHEMA = {
    "required": (),
    # `steps` is declared FIRST on purpose.
    #
    # Key order in JSON carries no meaning - `parse.ts` does not read it, and the compiler does not
    # depend on it - so this is purely about what the decoder is OFFERED first, and `_key_viable`
    # iterates these keys in order. With `constraints` first, MEASURED, the model spent its entire
    # budget on it: `["read-only","write-only","read-only","write-only",...]` until ARRAY_CAP, then a
    # trailing comma the grammar could not continue past, and the run ended in `mode=AFTER_VALUE` with
    # no plan at all. Offering the work before the commentary is a change to what the model is SHOWN
    # and to nothing else.
    "optional": ("steps", "expectedResult", "constraints", "refusal"),
    "fields": {
        "steps": (ARR, (OBJ, _step_schema())),
        "expectedResult": (STR,),
        "constraints": (ARR, (STR,)),
        "refusal": (STR,),
    },
}

# Schema arrays that may NOT be emitted empty.
#
# WHY THIS EXISTS, AND WHY IT IS A LIST RATHER THAN A SCHEMA FLAG
#
# `parse.ts` rejects `steps: []` outright - "the plan has zero steps, which is not a plan" - and it
# does so BEFORE anything executes. That is the right behaviour. But the grammar permitted the empty
# array, so constrained generation could spend a whole plan budget producing output the parser was
# always going to discard: the model is steered away from a legal document for reasons of its own,
# then the result is rejected for a reason it could not have known. Constrained decoding is only
# worth having when the constraint it enforces is one the system actually holds.
#
# `steps` is named here rather than carrying a `min_items` in its schema tuple because `_Frame`
# stores the array's ELEMENT spec (`elem`), not the tuple, so a third tuple element would never reach
# the frame without widening `_Frame.__slots__` and its clone. The frame already knows the key its
# array belongs to (`open_key`), so that is what this checks - and only for schema-driven arrays,
# never for the free-form ones inside `args`.
#
# `steps` is deliberately NOT made a required key. A plan that refuses rather than plans is a valid
# outcome the parser understands, and requiring `steps` would make `{"refusal": "..."}` inexpressible
# - turning a correctness improvement into a new refusal.
#
# `dependsOn` stays freely empty-able: `"dependsOn": []` is the normal first step, and an earlier
# version of this grammar refused it, which made the most common field in the schema the one the
# grammar could not express.
# Field names that belong to the STEP object and may never appear inside a free-form object.
#
# MEASURED: the model wrote `dependsOn`, `rationale`, `verification`, `expectedResult` and
# `onFailure` INSIDE `args`, three times over, because `args` is free-form and nothing said otherwise.
# A duplicate key is equally unrepresentable in well-formed JSON that a parser will read the way a
# human reads it - `{"a":1,"a":2}` has two defensible meanings and no standard resolution - so a plan
# carrying one is not a plan anybody can check.
#
# The list is the STEP schema's own key set, so it cannot drift from the schema it protects.
RESERVED_STEP_KEYS = frozenset(_step_schema()["required"]) | frozenset(_step_schema()["optional"])

NON_EMPTY_ARRAY_KEYS = frozenset({"steps"})

WS = (0x20, 0x09, 0x0A, 0x0D)
_HEX = "0123456789abcdefABCDEF"

# CHARACTER sets, because the machine consumes `str`. `allowed_bytes` converts to ordinals at the
# end, since that is what a logit mask needs. Mixing the two is a bug that reads as "the grammar
# rejects everything", which is exactly how it presented.
_KEY_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789")
_NUM_CHARS = set("-+.eE0123456789")
_STR_ESCAPE_CHARS = set('"\\bfnrtu')
_LITERALS = {"t": "true", "f": "false", "n": "null"}

KEY_LEN_CAP = 40


# ---------------------------------------------------------------- numbers

def _number_prefix_ok(buf: str) -> bool:
    """
    Whether `buf` is a valid PREFIX of a JSON number.

    An earlier version conflated prefix validity with completeness and rejected `1e` the moment the
    `e` arrived - which made `1e3` inexpressible, because the check fired before the digits did.
    Completeness is `_number_ok`'s job, and it only runs at a delimiter.

    It also checked `buf[0] not in "0123456789"` before handling the sign, so EVERY negative number
    was rejected. That surfaced as "the grammar cannot express a negative operand", which reads like
    the model's fault and is not.
    """
    if not buf:
        return False
    i = 0
    if buf[i] == "-":
        i += 1
        if i >= len(buf):
            return True                      # "-" alone is a valid prefix
    start = i
    while i < len(buf) and buf[i].isdigit():
        i += 1
    if i == start:
        return False                          # no integer digits
    if i < len(buf) and buf[i] == ".":
        i += 1
        frac = i
        while i < len(buf) and buf[i].isdigit():
            i += 1
        if i == frac and i < len(buf):
            return False                      # "1.x" can never become a number
        # "1." is a valid PREFIX; completeness is the delimiter's business.
    if i < len(buf) and buf[i] in "eE":
        i += 1
        if i < len(buf) and buf[i] in "+-":
            i += 1
        exp = i
        while i < len(buf) and buf[i].isdigit():
            i += 1
        if i == exp and i < len(buf):
            return False                      # "1e+" cannot become a number
        # "1e" and "1e+" are valid PREFIXES.
    return i == len(buf)


def _number_ok(buf: str) -> bool:
    """A number must be COMPLETE when a delimiter arrives: `1.`, `1e` and `-` are not numbers."""
    if not buf:
        return False
    if buf[-1] in ".eE" or buf in ("-", "+"):
        return False
    if buf[-1] in "+-":
        return False
    return _number_prefix_ok(buf)


# ---------------------------------------------------------------- state

class _Frame:
    """One container on the stack."""

    __slots__ = ("kind", "schema", "elem", "seen", "count", "open_key")

    def __init__(self, kind, schema=None, elem=None, open_key=""):
        self.kind = kind          # 'root' | 'obj' | 'arr' | 'free_obj' | 'free_arr'
        self.schema = schema
        self.elem = elem
        # The key in the PARENT frame that this container's value belongs to.
        #
        # Needed because a single `pending_key` slot is clobbered by anything nested: opening
        # `verification` overwrote the key `args`, so neither was ever recorded on the step object and
        # every plan with BOTH was rejected as missing required fields. The bug lived in the one place
        # the grammar was supposed to be loosest.
        self.open_key = open_key
        self.seen: set[str] = set()
        self.count = 0


class State:
    """Mutable parser state. Cloned before speculatively trying a candidate token."""

    __slots__ = ("stack", "mode", "key_buf", "pending_key", "str_buf", "escaped",
                 "num_buf", "lit_want", "depth", "done", "failed", "after_comma")

    def __init__(self):
        self.stack = [_Frame("root", schema=ROOT_SCHEMA)]
        self.mode = "OBJ_START"
        self.key_buf = ""
        self.pending_key = ""
        self.str_buf = ""
        self.escaped = False
        self.num_buf = ""
        self.lit_want = ""
        self.depth = 1
        self.done = False
        self.failed = False
        self.after_comma = False

    def clone(self) -> "State":
        s = State()
        s.stack = [_Frame(f.kind, f.schema, f.elem, f.open_key) for f in self.stack]
        for src, dst in zip(self.stack, s.stack):
            dst.seen = set(src.seen)
            dst.count = src.count
        s.mode = self.mode
        s.key_buf = self.key_buf
        s.pending_key = self.pending_key
        s.str_buf = self.str_buf
        s.escaped = self.escaped
        s.num_buf = self.num_buf
        s.lit_want = self.lit_want
        s.depth = self.depth
        s.done = self.done
        s.failed = self.failed
        s.after_comma = self.after_comma
        return s


# ---------------------------------------------------------------- the grammar

class PlanGrammar:
    def __init__(self, string_cap=STRING_CAP, array_cap=ARRAY_CAP, depth_cap=DEPTH_CAP):
        self.string_cap = string_cap
        self.array_cap = array_cap
        self.depth_cap = depth_cap

    # ---------------------------------------------------------------- API

    def start(self) -> State:
        return State()

    def complete(self, s) -> bool:
        return bool(s) and s.done and not s.failed and len(s.stack) == 0

    def accepts_eos(self, s) -> bool:
        """
        Whether the decoder may stop here.

        ONLY a complete document may be stopped at. A truncated one may not, which is what makes
        truncation impossible to emit rather than merely detectable afterwards: the mask removes EOS
        from every incomplete state, so a model that runs out of ideas cannot terminate mid-object and
        hand a fragment to the parser as though it were a plan.
        """
        return self.complete(s)

    def feed(self, s: State, text: str):
        """
        Advance over `text`, returning a NEW state, or None if the text leaves the grammar.

        The input is CLONED. This is not tidiness - it is load-bearing. The decode loop tries one
        candidate token after another from the SAME state, and `_char` mutates in place, so a feed that
        did not clone left the shared state corrupted by the first candidate that failed. Every
        subsequent candidate then failed too, and constrained generation aborted with "every permitted
        token was rejected" on a state that was still perfectly valid.

        The grammar's own unit tests missed it because each one started from a fresh state and so never
        fed the same state twice.
        """
        cur = s.clone()
        for ch in text:
            cur = self._char(cur, ch)
            if cur is None:
                return None
        return cur

    def allowed_bytes(self, s: State) -> set:
        if s.failed or s.done:
            return set()
        # An INCOMPLETE document is not an error - it is the normal state of a document still being
        # written, and incremental decoding depends on being able to continue one. What matters is that
        # only `allowed_bytes` on an ACCEPTING state includes EOS, so a truncated document can never be
        # emitted as a finished one.
        out = set(WS)
        m = s.mode
        top = s.stack[-1] if s.stack else None

        if m == "OBJ_START":
            out.add(0x7B)
        elif m == "KEY_OR_END":
            out |= {0x7B, 0x22}
            if top and top.kind == "free_obj":
                out.add(0x7D)
            elif not s.after_comma and top and top.kind in ("obj", "root") and self._can_close(top):
                out.add(0x7D)
        elif m == "AFTER_VALUE":
            if top and top.kind in ("obj", "root", "free_obj"):
                out |= {0x2C, 0x7D}
            elif top and top.kind in ("arr", "free_arr"):
                out |= {0x2C, 0x5D}
        elif m == "IN_KEY":
            # PREFIX VIABILITY. For a schema object the key must remain a prefix of some field that
            # has not already been used, so the mask only offers characters that keep it one.
            #
            # This is what stops the deadlock measured in M10: the model emitted the key prefix
            # `outputFilePathCSharpCodeExample123456789`, a prefix of no field in the schema, and from
            # that state ZERO of 34,192 candidate tokens were acceptable - so generation aborted
            # instead of refusing. An unconstrained key mask permits exactly that.
            if top and top.kind == "free_obj":
                out |= {ord(c) for c in _KEY_CHARS} | {0x22}
            else:
                out |= self._key_prefix_bytes(s)
                out.add(0x22)
                if not s.key_buf and top and top.kind in ("obj", "root") and self._can_close(top):
                    out.add(0x7D)
        elif m == "COLON":
            out.add(0x3A)
        elif m == "VALUE":
            top = s.stack[-1]
            if top.kind in ("arr", "free_arr") and self._array_may_close(top):
                out.add(0x5D)
            if top.kind == "free_obj" and not top.seen:
                out.add(0x7D)
            self._value_bytes(s, out)
        elif m == "IN_STR":
            out.add(0x22)
            self._str_bytes(s, out)
        elif m == "IN_NUM":
            # A number ENDS at a delimiter, so the delimiters must be legal WHILE a number is being read.
            #
            # Measured defect: the mask offered only number characters here, and once `num_buf` reached
            # its length cap those ran out - leaving whitespace as the only permitted bytes. No token in
            # the vocabulary starts with a bare space, so generation aborted with "no token starts with
            # any of the permitted bytes [9, 10, 13, 32] (mode=IN_NUM)". A 24-character number wedged
            # the machine permanently.
            #
            # The character machine accepted these delimiters all along. The mask and the machine
            # disagreeing is the real lesson: a constraint is only trustworthy if BOTH halves agree,
            # and testing one without the other proves nothing.
            out |= {0x2C, 0x7D, 0x5D}
            out |= self._num_bytes(s)
        elif m == "LITERAL":
            if len(s.lit_want) > len(s.num_buf):
                out.add(ord(s.lit_want[len(s.num_buf)]))
        return out

    # ---------------------------------------------------------------- key viability

    def _key_viable(self, s: State) -> list:
        """
        Field names this object could still accept, given what has already been used.

        AN OPTIONAL FIELD IS ONLY OFFERED ONCE EVERY REQUIRED ONE IS PRESENT.

        MEASURED, and this was a real dead end rather than a style point. A step carries one optional
        key, `effect`. The model emitted `effect` early - before `dependsOn`, `rationale`,
        `verification` and `onFailure` - and then could not escape: `effect` completed, so the only
        byte the grammar would take was `}`, but closing the STEP object is illegal while required
        fields are missing, and no required key was offered because the grammar was waiting inside a
        nested object it had already finished. Generation aborted with "every permitted token was
        rejected", 610 candidates tried. The plan was unterminated and the parser refused it.

        Nothing about the model was wrong in the sense that mattered here, and nothing about the
        requirement was wrong either: the step really did still owe four required fields. The defect
        was that the grammar let it commit to the optional one first and offered no way back. Ordering
        optional fields last removes the trap without removing the requirement - a required key is
        offered at EVERY position, so this can never withhold one, and `_can_close` still refuses to
        close an object whose required fields are absent.
        """
        f = s.stack[-1]
        if f.kind not in ("obj", "root") or f.schema is None:
            return []
        required = f.schema.get("required") or ()
        fields = f.schema["fields"]
        required_done = all(k in f.seen for k in required)
        return [
            k for k in fields
            if k not in f.seen and (k in required or required_done)
        ]

    def _key_chars(self, s: State) -> set:
        """
        Characters that keep `key_buf` a prefix of at least one still-available field name.

        When `key_buf` exactly matches a field, the next character must be the closing quote, so this
        returns the empty set - which is precisely the dead end the M10 deadlock walked into. The
        decoder then has no legal move, which is a REFUSAL rather than an abort.
        """
        buf = s.key_buf
        out = set()
        f = s.stack[-1]
        if f.kind == "free_obj":
            # A free-form object's vocabulary is OPEN, so a prefix cannot be filtered down to the
            # names that are still available - almost every letter begins some plausible name. What
            # CAN be decided is the exact-match case, and it is the same rule the schema branch
            # applies: once `buf` IS a name that may not be used here, the key has to be closed.
            # `allowed_bytes` always offers the closing quote in IN_KEY, so this narrows the mask
            # without ever dead-ending the decoder.
            #
            # An earlier version filtered every character whose PREFIX appeared among the reserved
            # names, and blocked `deep`, `count` and `nested` because `d`, `c` and `n` also begin
            # `dependsOn`, `capability` and `intent`. Restricting the vocabulary of a free-form
            # object is not this grammar's job - the tool decides what its operands are.
            if buf and (buf in f.seen or buf in RESERVED_STEP_KEYS):
                return set()
            return set(_KEY_CHARS)
        for name in self._key_viable(s):
            if name.startswith(buf) and len(name) > len(buf):
                out.add(name[len(buf)])
        return out

    def _key_prefix_bytes(self, s: State) -> set:
        return {ord(c) for c in self._key_chars(s)}

    # ---------------------------------------------------------------- the character machine

    def _char(self, s: State, ch: str):
        if s.failed or s.done:
            return None
        if ch in " \t\n\r":
            return s
        m = s.mode

        if m == "OBJ_START":
            return self._open_root(s) if ch == "{" else None

        if m == "KEY_OR_END":
            top = s.stack[-1]
            if ch == "}":
                # A FREE-FORM object has no required keys, so `{}` is always legal. The after_comma
                # guard applies only to schema objects, where a comma promises another member.
                if top.kind == "free_obj":
                    return self._close_container(s, top.open_key)
                if s.after_comma:
                    return None
                if top.kind in ("obj", "root") and self._can_close(top):
                    return self._close_container(s, top.open_key)
                return None
            if ch == '"':
                s.mode = "IN_KEY"
                s.key_buf = ""
                s.after_comma = False
                return s
            return None

        if m == "AFTER_VALUE":
            top = s.stack[-1]
            if ch == ",":
                # A comma is a promise that another element follows, so the state after it must NOT
                # accept a closing bracket. Allowing it made `{"refusal":"a",}` valid, which is a
                # trailing comma - invalid JSON, and a grammar that waves it through is not a grammar
                # worth having.
                s.after_comma = True
                if top.kind in ("arr", "free_arr"):
                    s.mode = "VALUE"
                    return s
                s.mode = "KEY_OR_END"
                return s
            if ch == "}" and top.kind in ("obj", "root", "free_obj"):
                return self._close_container(s, top.open_key)
            if ch == "]" and top.kind in ("arr", "free_arr"):
                return self._close_container(s, top.open_key)
            return None

        if m == "IN_KEY":
            if ch == '"':
                key = s.key_buf
                top = s.stack[-1]
                if top.kind == "free_obj":
                    # A FREE-FORM object takes any key, but not EVERY key.
                    #
                    # Two rules, both about the object being CHECKABLE rather than about the plan
                    # being valid:
                    #   - a key may not repeat. A duplicate has two defensible readings and no
                    #     standard resolution, so a plan carrying one cannot be verified.
                    #   - a key may not be one of the STEP's own field names. Those belong to the
                    #     step object; a copy of `verification` sitting inside `args` is not an
                    #     operand, and MEASURED the model emitted exactly that.
                    #
                    # The real key is recorded in `seen` while `pending_key` stays the FREE sentinel,
                    # so `_expected` still treats every value here as unconstrained. Only the KEY is
                    # constrained; the operands themselves remain the tool's business, which is the
                    # property the module docstring depends on and which this does not touch.
                    if key in RESERVED_STEP_KEYS or key in top.seen:
                        return None
                    top.seen.add(key)
                    s.pending_key = FREE_KEY
                else:
                    if top.kind not in ("obj", "root"):
                        return None
                    if key in top.seen or key not in top.schema["fields"]:
                        return None
                    s.pending_key = key
                s.after_comma = False
                s.mode = "COLON"
                return s
            if ch not in _KEY_CHARS or len(s.key_buf) >= KEY_LEN_CAP:
                return None
            # Same viability rule as the mask. Enforcing it in only one of the two places is how a
            # grammar ends up advertising a character and then refusing it.
            if s.stack[-1].kind != "free_obj" and ch not in self._key_chars(s):
                return None
            if s.stack[-1].kind == "free_obj" and ch not in self._key_chars(s):
                return None
            s.key_buf += ch
            return s

        if m == "COLON":
            if ch != ":":
                return None
            s.mode = "VALUE"
            return s

        if m == "VALUE":
            # An EMPTY array or object is `[]` / `{}`, so a closer is legal in VALUE position when no
            # element has been read. Without this, `"dependsOn": []` was rejected - which is how the
            # most common field in the schema turned out to be the one the grammar could not express.
            top = s.stack[-1]
            if ch == "]" and top.kind in ("arr", "free_arr") and self._array_may_close(top):
                return self._close_container(s, top.open_key)
            if ch == "}" and top.kind == "free_obj" and not top.seen:
                return self._close_container(s, top.open_key)
            return self._begin_value(s, ch)

        if m == "IN_STR":
            return self._string_char(s, ch)

        if m == "IN_NUM":
            # A number ENDS at a delimiter. Without this, `[1,2]` was rejected: the comma could not
            # follow the `1`, so no array of numbers was expressible.
            if ch in ",}]" or ch in " \t\n\r":
                if not _number_ok(s.num_buf):
                    return None
                # `_value_done`, not just the mode: it is what registers the key on the parent object.
                # Setting AFTER_VALUE alone left `"args": -5` unregistered, so every plan with a scalar
                # operand was rejected for a missing required field that was present in the text.
                s = self._value_done(s)
                return self._char(s, ch)   # re-dispatch the delimiter in the new state
            if ch not in _NUM_CHARS:
                return None
            if len(s.num_buf) >= 24:
                # At the cap: REFUSE CLEANLY rather than rejecting this one character.
                #
                # Rejecting mid-number left the machine and the mask disagreeing - the mask stopped
                # offering digits while the machine was still consuming them - so which of the two
                # governed depended on how the text arrived. A number this long is not a number worth
                # having; failing the document is a decision, whereas rejecting one character is a
                # side effect.
                s.failed = True
                return s
            s.num_buf += ch
            if not _number_prefix_ok(s.num_buf):
                return None
            return s

        if m == "LITERAL":
            i = len(s.num_buf)
            if i >= len(s.lit_want) or ch != s.lit_want[i]:
                return None
            s.num_buf += ch
            if len(s.num_buf) == len(s.lit_want):
                return self._value_done(s)
            return s

        return None

    # ---------------------------------------------------------------- values

    def _array_may_close(self, top) -> bool:
        """
        Whether this array is allowed to close with nothing in it.

        Split out because the mask and the character machine must agree. Measured before: they did
        not, and the disagreement presented as "the grammar randomly rejects valid plans". Only
        schema arrays are constrained here - a free-form array inside `args` is the model's to shape.
        """
        if top.kind != "arr":
            return True
        if top.count > 0:
            return True
        return top.open_key not in NON_EMPTY_ARRAY_KEYS

    def _expected(self, s: State):
        top = s.stack[-1]
        if top.kind == "arr":
            return top.elem
        # A free-form container's values are unconstrained whatever the key was called. Without this
        # branch the grammar raised "NoneType is not subscriptable" on the first value inside `args` -
        # which is exactly where the grammar was written to be MOST permissive, so the bug hid in the
        # one spot a structural test is least likely to look.
        if top.kind in ("free_arr", "free_obj"):
            return (FREE,)
        # The free sentinel means "this value is unconstrained", and it can be set while the top frame
        # is a SCHEMA object - `args` is a free slot on the step, so a bare string there is legal.
        # Reading it out of the schema by name raised KeyError, a crash rather than a decision.
        if s.pending_key == FREE_KEY:
            return (FREE,)
        return top.schema["fields"][s.pending_key]

    def _value_bytes(self, s: State, out: set) -> None:
        spec = self._expected(s)
        kind = spec[0]
        if kind == FREE:
            out |= {0x7B, 0x5B, 0x22, 0x74, 0x66, 0x6E} | {ord(c) for c in _NUM_CHARS}
        elif kind in (STR, ENUM):
            out.add(0x22)
        elif kind == BOOL:
            out |= {0x74, 0x66}
        elif kind == OBJ:
            out.add(0x7B)
        elif kind == ARR:
            out.add(0x5B)

    def _begin_value(self, s: State, ch: str):
        spec = self._expected(s)
        kind = spec[0]

        if kind == FREE:
            return self._begin_free(s, ch)

        if kind in (STR, ENUM):
            if ch != '"':
                return None
            s.mode = "IN_STR"
            s.str_buf = ""
            s.escaped = False
            return s
        if kind == BOOL:
            if ch in "tf":
                s.mode = "LITERAL"
                s.lit_want = _LITERALS[ch]
                s.num_buf = ch
                return s
            return None
        if kind == OBJ:
            if ch != "{" or s.depth + 1 > self.depth_cap:
                return None
            s.stack.append(_Frame("obj", schema=spec[1], open_key=s.pending_key))
            s.depth += 1
            s.mode = "KEY_OR_END"
            return s
        if kind == ARR:
            if ch != "[" or s.depth + 1 > self.depth_cap:
                return None
            s.stack.append(_Frame("arr", elem=spec[1], open_key=s.pending_key))
            s.depth += 1
            s.mode = "VALUE"
            return s
        return None

    def _begin_free(self, s: State, ch: str):
        """
        Any JSON value at all. The most permissive branch, and deliberately so.

        Note what is NOT here: `s.pending_key = FREE_KEY` on the scalar branches. A free slot can sit
        on a SCHEMA object - `args` is one - and overwriting the key there meant `"args": -5` never
        registered `args` on the step, so every plan with a scalar operand was rejected as missing a
        required field. The key is only unknown inside a free-form container, and the frame already
        remembers what it was opened for.
        """
        if s.depth + 1 > self.depth_cap:
            return None
        if ch == "{":
            s.stack.append(_Frame("free_obj", open_key=s.pending_key))
            s.depth += 1
            s.mode = "KEY_OR_END"
            return s
        if ch == "[":
            s.stack.append(_Frame("free_arr", open_key=s.pending_key))
            s.depth += 1
            s.mode = "VALUE"
            return s
        if ch == '"':
            s.mode = "IN_STR"
            s.str_buf = ""
            s.escaped = False
            return s
        if ch in "tfn":
            s.mode = "LITERAL"
            s.lit_want = _LITERALS[ch]
            s.num_buf = ch
            return s
        if ch in "-0123456789":
            s.mode = "IN_NUM"
            s.num_buf = ch
            return s
        return None

    # ---------------------------------------------------------------- strings

    def _string_char(self, s: State, ch: str):
        if s.escaped:
            if ch not in _HEX and ch not in _STR_ESCAPE_CHARS:
                return None
            s.escaped = False
            s.str_buf += ch
            return s
        if ch == "\\":
            s.escaped = True
            return s
        if ch == '"':
            spec = self._expected(s)
            if spec[0] == ENUM and s.str_buf not in spec[1]:
                return None
            return self._value_done(s)
        if ord(ch) < 0x20 or len(s.str_buf) >= self.string_cap:
            return None
        if self._expected(s)[0] == ENUM:
            allowed = self._expected(s)[1]
            cand = s.str_buf + ch
            if not any(v.startswith(cand) for v in allowed):
                return None
        s.str_buf += ch
        return s

    def _str_bytes(self, s: State, out: set) -> None:
        if s.escaped:
            out |= set(_HEX.encode()) | {ord(c) for c in _STR_ESCAPE_CHARS}
            return
        spec = self._expected(s)
        if spec[0] == ENUM:
            for v in spec[1]:
                if v.startswith(s.str_buf) and len(v) > len(s.str_buf):
                    out.add(ord(v[len(s.str_buf)]))
        else:
            out |= set(range(0x20, 0x80)) | {0x22, 0x5C}

    def _num_bytes(self, s: State) -> set:
        return {ord(c) for c in _NUM_CHARS} if len(s.num_buf) < 24 else set()

    def _value_done(self, s: State) -> State:
        """A scalar (string, number, literal) finished. Register it, then advance containers."""
        s.mode = "AFTER_VALUE"
        top = s.stack[-1]
        if top.kind in ("arr", "free_arr"):
            top.count += 1
            if top.count > self.array_cap:
                s.failed = True
        if s.pending_key and s.pending_key != FREE_KEY:
            top.seen.add(s.pending_key)
            s.pending_key = ""
        return s

    # ---------------------------------------------------------------- containers

    def _open_root(self, s: State) -> State:
        s.mode = "KEY_OR_END"
        return s

    def _can_close(self, f: _Frame) -> bool:
        if f.kind not in ("obj", "root"):
            return True
        return all(k in f.seen for k in f.schema["required"])

    def _close_container(self, s: State, override_key: str = ""):
        f = s.stack[-1]
        if f.kind == "root":
            if not self._can_close(f):
                return None
            s.stack.pop()
            s.depth -= 1
            s.done = True
            s.mode = "DONE"
            return s
        if f.kind == "obj":
            if not self._can_close(f):
                return None
            s.stack.pop()
            s.depth -= 1
            return self._ascend(s, f.open_key)
        if f.kind in ("arr", "free_obj", "free_arr"):
            s.stack.pop()
            s.depth -= 1
            return self._ascend(s, f.open_key)
        return None

    def _ascend(self, s: State, child_key: str) -> State:
        """A child container closed. Register it in its parent under the key IT was opened for."""
        parent = s.stack[-1]
        if parent.kind in ("arr", "free_arr"):
            parent.count += 1
            if parent.count > self.array_cap:
                s.failed = True
        elif parent.kind in ("obj", "root") and child_key and child_key != FREE_KEY:
            parent.seen.add(child_key)
            s.pending_key = ""
        s.mode = "AFTER_VALUE"
        return s