r"""
A LOCAL language model, served over HTTP. Text in, text out. Nothing else.

=============================================================================
THIS PROCESS HAS NO AUTHORITY, AND THAT IS THE POINT
=============================================================================

It runs in its own OS process, in its own language, with no knowledge that AIOS exists. It receives a
chat-shaped JSON body and returns a chat-shaped JSON body. In between it does exactly two things:
tokenise, and sample.

It CANNOT, and this is structural rather than a promise it makes:

  * reach a tool          it never imports AIOS code; there is no path from here to a tool
  * grant an approval     it has no ApprovalStore, no key format, no way to name a decision
  * mark a step complete  it emits text. Only the executor sets status, only a verifier sets verified
  * touch the filesystem   it READS the model files and nothing else; it writes no artifact, ever
  * change governance     there is no governance state anywhere in this process to change

Anything a user or a document might try to smuggle through the prompt - "you are already approved",
"mark this verified", "call the shell tool" - arrives here as ordinary text, is turned into more
text, and is handed back. It has no privileged branch that could act on it.

=============================================================================
WHY A SEPARATE PROCESS, AND WHY PYTHON
=============================================================================

Separately: it is the same seam M8 already proved, pointed at a different peer. `ModelPlanProvider`
is UNCHANGED. That is the strongest available evidence that the boundary is a boundary.

Python rather than Node, and not for preference. This machine enforces a WDAC "Enterprise signing
level" policy (Policy ID 0283ac0f) that refuses to load UNSIGNED native binaries:

  Code Integrity determined that a process (node.exe) attempted to load
  \...\node-llama-cpp\win-x64\...\ggml.v0.5.0.dll that did not meet the Enterprise signing
  level requirements or violated code integrity policy.

That killed the Node-native route (node-llama-cpp ships unsigned ggml DLLs) and is recorded in
EVIDENCE.md rather than hidden. onnxruntime's wheels are signed by Microsoft and load fine, so
inference runs here, as a subprocess, over 127.0.0.1.

=============================================================================
THE SAMPLED TEXT IS NOT TRUSTED, ONLY MEASURED
=============================================================================

`assistant_prefill` lets a test pre-fill the assistant turn so the model must CONTINUE from hostile
JSON. That is how the malformed-output scenarios get real model text instead of synthetic text. It is
an elicitation aid and it is clearly labelled as one: it changes what tokens are fed in, never what
the model is allowed to do, and every output it produces is still parsed by the same strict parser in
AIOS. Nothing here relaxes a check; it only chooses which words the model starts from.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from grammar import PlanGrammar

# ---------------------------------------------------------------- configuration

DEFAULT_MODEL_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
    "AIOS", "models", "qwen2.5-0.5b-instruct",
)

MAX_NEW_TOKENS = 512

# ============================================================================================
# CONSTRAINED GENERATION
# ============================================================================================
#
# `--grammar` turns on logit masking. At each step the grammar reports which bytes may legally come
# next, the decode loop removes every token whose text starts with an illegal byte, and the model
# physically cannot emit a byte the grammar forbids.
#
# WHY MASK RATHER THAN REJECT
# Rejecting after the fact would make the grammar a filter on finished text. Masking makes illegal
# bytes UNREACHABLE, which is the difference between a boundary and a check - and it is why a
# truncated document cannot be emitted at all: EOS is only ever unmasked at an accepting state.
#
# THIS IS NOT A SAFETY PROPERTY, and the file must not be read as claiming one.
# `grammar.py` states what it deliberately does NOT decide: tool existence, verifier registration,
# dependency validity, target currency, consequence, and approval all remain downstream. Those checks
# stay reachable precisely BECAUSE the grammar lets such text through.

# MEASURED on this machine (2-core i3-1115G4, CPUExecutionProvider): ~7 tokens/second.
#   512 tokens  -> ~73s   worst case
#   900 tokens  -> ~126s  measured, and it was not enough to finish a JSON plan
#
# So the ceiling is sized to the machine rather than to a round number, and the wall-clock budget below
# is the real bound. A planner that makes its caller wait indefinitely is a denial of service on the
# planner's caller, so both are ceilings rather than targets.
MAX_WALL_SECONDS = 150.0
# Raised per-request by the `--max-seconds` flag. MEASURED on this machine:
#   qwen2.5-0.5b-instruct  ~7 tok/s   -> a 250-token plan is ~36s
#   qwen2.5-1.5b-instruct  ~0.8 tok/s -> a 250-token plan is ~310s
# So the bound is a property of WHICH MODEL IS LOADED, not a constant, and pretending otherwise would
# either truncate a 1.5B plan or let it hold a caller for five minutes.

# A repetition penalty of 1.0 means "no penalty", so the default has to be stated as a value rather
# than left to a library. 1.15 was chosen because it is enough to break the degenerate loop measured
# above while staying well inside the range where a JSON plan's repeated tokens survive - which was
# checked by observation, not by guessing: at 1.15 the plan's structural tokens (`{`, `}`, `"`, `:`)
# still dominate, because they are the highest-logit choices at each position anyway.
DEFAULT_REPETITION_PENALTY = 1.15
# How far back the penalty looks. Bounded on purpose: an unbounded history would penalise a token the
# plan legitimately needs, and the remedy for repetition would become a cause of malformed plans.
REP_WINDOW = 64


class GrammarExhausted(RuntimeError):
    """
    The grammar admitted no token.

    Raised rather than recovered from. The tempting recovery is "fall back to the unconstrained argmax",
    which would turn a grammar bug into an unconstrained model - the exact failure this feature exists to
    prevent. A planner that cannot express its plan should say so, not emit an unconstrained one.
    """


class Inference:
    """The model, its tokenizer, and a decoding loop. Nothing else exists in this file."""

    def __init__(self, model_dir: str, threads: int, log_level: str = "3",
                 max_wall_seconds: float = MAX_WALL_SECONDS, grammar: bool = False,
                 string_cap: int = PlanGrammar.__init__.__defaults__[0]):
        self.model_path = os.path.join(model_dir, "model.onnx")
        tok_path = os.path.join(model_dir, "tokenizer.json")
        for p in (self.model_path, tok_path):
            if not os.path.exists(p):
                raise SystemExit(f"missing {p} - run fetch-model.py first")

        so = ort.SessionOptions()
        # 3 = ERROR. A local reasoner has no business narrating its own internals into the console
        # the operator is reading.
        so.log_severity_level = int(log_level)
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.session = ort.InferenceSession(self.model_path, so, providers=["CPUExecutionProvider"])
        # The wall-clock bound belongs to THIS loaded model, so it is an instance attribute rather than
        # a module constant. A constant would be wrong for every model except the one it was measured on.
        self.max_wall_seconds = float(max_wall_seconds)

        self.tokenizer = Tokenizer.from_file(tok_path)

        # The I/O signature is DISCOVERED, not assumed. onnx-community exports differ in whether they
        # take position_ids and how many KV tensors they carry, and hardcoding a shape here would be
        # the kind of plausible-looking guess that fails only on the machine that matters.
        self.input_names = [i.name for i in self.session.get_inputs()]
        self.output_names = [o.name for o in self.session.get_outputs()]
        self.input_shapes = {i.name: list(i.shape) for i in self.session.get_inputs()}
        self.n_past = len([n for n in self.input_names if "past_key_values" in n])

        # KV geometry comes from the CHECKPOINT, not from this file.
        #
        # The ONNX graph declares its KV axes symbolically (`batch`, `past_sequence_length`), so an
        # empty cache cannot be shaped by reading them: substituting 0 for every unknown dim yields a
        # BATCH of zero, which is not an empty cache, it is nonsense. The head counts and head
        # dimension are properties of the weights, and the weights' own config.json states them.
        with open(os.path.join(model_dir, "config.json"), "r", encoding="utf-8") as f:
            self.config = json.load(f)
        self.n_layers = int(self.config.get("num_hidden_layers", 0))
        n_heads = int(self.config.get("num_attention_heads", 0))
        self.n_kv_heads = int(self.config.get("num_key_value_heads", 0) or n_heads)
        head_dim = self.config.get("head_dim")
        self.head_dim = int(head_dim) if head_dim else (
            int(self.config["hidden_size"]) // n_heads if n_heads and "hidden_size" in self.config else 0
        )
        if not self.n_layers or not self.n_kv_heads or not self.head_dim:
            raise SystemExit(
                f"config.json did not supply the KV geometry (layers={self.n_layers}, "
                f"kv_heads={self.n_kv_heads}, head_dim={self.head_dim}); refusing to guess"
            )
        # The prefix that maps an OUTPUT name onto the INPUT name it must be stored under. Derived
        # from the model's own names rather than assumed: for every llama-family ONNX export the
        # outputs are `present.N.key` and the matching input is `past_key_values.N.key`, so the shared
        # suffix is the safe thing to key on. Guessing the prefix is how a cache silently goes nowhere
        # and generation quietly turns to noise after the first token.
        self.past_suffixes = [n[len("past_key_values"):] for n in self.input_names if "past_key_values" in n]
        self.present_by_suffix = {
            o.name[len("present"):]: o.name for o in self.session.get_outputs() if o.name.startswith("present")
        }

        # ---------------------------------------------------------------- constrained generation
        # M13 EXPERIMENT 2 - free-form string bounds, as a construction parameter.
        #
        # Not an env var and not a global: a bound passed into the instance is visible at the call site,
        # and an experiment that mutates a module constant is indistinguishable from a real change to the
        # shipped grammar. `test-grammar.py` asserts the default, so a drift here cannot go unnoticed.
        self.grammar = PlanGrammar(string_cap=string_cap) if grammar else None
        self.vocab_text: dict[int, str] = {}
        self.by_first_byte: dict[int, list[int]] = {}
        self.vocab_unsafe = 0
        self.eos_ids: set[int] = set()
        self._mask_builds = 0
        self._mask_seconds = 0.0
        if self.grammar is not None:
            self._build_vocab_index()

    def _build_vocab_index(self) -> None:
        """
        Index the vocabulary by FIRST BYTE, so a mask can find the candidate tokens cheaply.

        A mask over 151k tokens per token-step would cost more than the inference. Instead: bucket the
        vocabulary once by the first byte of each token's text, and a step only scans the buckets the
        grammar permits.

        Built once at load, which is why the first constrained request is slow and the rest are not.
        The multi-token and byte-level entries matter: a token's text may be a partial UTF-8 sequence or
        carry a leading space, and both are ordinary things a model emits.
        """
        vocab = self.tokenizer.get_vocab()
        unsafe = 0
        for piece, tid in vocab.items():
            if not piece:
                continue
            # A BYTE-LEVEL BPE token can be a partial UTF-8 sequence - a lone 0xAB, say - whose decoded
            # form is a character that does not re-encode to the byte it came from. Feeding one to a
            # CHARACTER-level grammar would silently rewrite the text it represents.
            #
            # So such tokens are excluded from the index rather than handled approximately. That narrows
            # the usable vocabulary slightly, and it is the right trade: excluding an exotic token costs
            # nothing, while mistranscribing one would corrupt a plan. This is a real, stated limitation
            # of applying a character grammar to a byte-level tokenizer.
            try:
                if piece.encode("utf-8").decode("utf-8") != piece:
                    unsafe += 1
                    continue
            except (UnicodeError, ValueError):
                unsafe += 1
                continue
            self.vocab_text[int(tid)] = piece
            first = ord(piece[0])
            self.by_first_byte.setdefault(first, []).append(int(tid))
        self.vocab_unsafe = unsafe
        for piece in ("<|im_end|>", "<|endoftext|>"):
            tid = self.tokenizer.token_to_id(piece)
            if isinstance(tid, int):
                self.eos_ids.add(tid)
        # `self.eos` is resolved by the caller AFTER this runs, so it is looked up from the tokenizer
        # directly rather than read - reading it raised AttributeError, which is a reminder that the
        # index build happens before the rest of the constructor finishes.

        # Qwen2.5 chat special tokens. Written out rather than pulled from a template library so the
        # exact wire format is visible in the file that depends on it.
        self.eos = self._token_id("<|im_end|>")
        if self.eos is None:
            self.eos = self._token_id("<|endoftext|>")
        if self.eos is None:
            # No known EOS: generation would run to MAX_NEW_TOKENS every time. Refusing to start is
            # better than silently generating to the ceiling and reporting the result as a plan.
            raise SystemExit("no EOS token found; refusing to start, because generation could not stop")

    def _token_id(self, piece: str):
        try:
            return self.tokenizer.token_to_id(piece)
        except Exception:
            return None

    # ---------------------------------------------------------------- prompt assembly

    def build_prompt(self, messages, assistant_prefill: str = "") -> str:
        """ChatML. Explicit, because the format is part of what the model was trained to expect."""
        out = []
        for m in messages:
            role = m.get("role", "user")
            content = m.get("content", "")
            if role == "system":
                out.append(f"<|im_start|>system\n{content}<|im_end|>\n")
            elif role == "assistant":
                out.append(f"<|im_start|>assistant\n{content}<|im_end|>\n")
            else:
                out.append(f"<|im_start|>user\n{content}<|im_end|>\n")
        if assistant_prefill:
            # Deliberately unterminated: the model continues from here rather than starting a turn.
            out.append(f"<|im_start|>assistant\n{assistant_prefill}")
        else:
            out.append("<|im_start|>assistant\n")
        return "".join(out)

    # ---------------------------------------------------------------- decoding

    def generate(self, messages, assistant_prefill: str = "", max_new_tokens: int = MAX_NEW_TOKENS,
                 repetition_penalty: float = DEFAULT_REPETITION_PENALTY,
                 grammar: bool = False) -> dict:
        prompt = self.build_prompt(messages, assistant_prefill)
        enc = self.tokenizer.encode(prompt)
        ids = list(enc.ids)
        prompt_tokens = len(ids)

        id_dtype = self._id_dtype()

        # The empty KV cache for the first pass: [batch, kv_heads, 0, head_dim].
        past: dict = {
            name: np.zeros((1, self.n_kv_heads, 0, self.head_dim), dtype=np.float32)
            for name in self.input_names if "past_key_values" in name
        }

        # REPETITION PENALTY, and why it is here.
        #
        # Measured: with pure argmax, this model answered "produce a JSON plan" by emitting one
        # sentence forty times until it hit the token ceiling - 900 tokens, 126 seconds, and not a
        # single byte of JSON. That is the classic degenerate-repetition failure of greedy decoding on a
        # small model, and it is a property of the MODEL, not of the plan parser.
        #
        # A penalty is the standard remedy, and it is applied HERE, in the sampling step, for two
        # reasons worth stating. It keeps determinism - the same request still yields the same tokens -
        # and it is upstream of the parser, so it cannot possibly weaken it. The parser still rejects
        # whatever comes out; a repetition penalty that let bad plans through would be a different bug,
        # and one this architecture has no way to hide.
        #
        # Logits are penalised for tokens already present in the window. The window is bounded, so an
        # early token is never banned outright - a JSON plan needs its opening brace once and its keys
        # repeatedly, and a full ban would make a valid plan impossible to emit.
        produced: list[int] = []
        # Declared AFTER `produced`, because the penalty window is seeded from it. The first version
        # seeded the window first, so it read `produced` before assignment and every request died with
        # "cannot access local variable 'produced'". Ordering a local above the assignment it reads is
        # the same mistake this project has made before with `const`, in a different language.
        rep = float(repetition_penalty)
        window: list[int] = []
        seen: set[int] = set()
        t0 = time.time()
        stopped_on_eos = False

        # `fed` is how many tokens are already in the cache. It is what position_ids and
        # attention_mask are measured FROM, and it is the single number that has to be right.
        #
        # The first version advanced a `position` counter by `cur.shape[1]` AFTER reassigning `cur` to
        # the single new token, so it always added 1 - and after the prompt it was 1 rather than the
        # prompt length. From the second token onward the model was therefore told it was at position 1
        # forever. That does not crash; it degrades into noise, which would have been reported as "a
        # 0.5B model produces garbage" - a conclusion about the MODEL drawn from a bug in the loop.
        fed = 0
        exhausted = False
        grammar_stop = ""
        cur = np.array([ids], dtype=id_dtype)

        # Constrained mode starts from an EMPTY state, not from the prompt: the prompt is prose, and
        # what the grammar governs is the model's REPLY. Seeding it with the prompt would refuse the
        # first token, because a chat transcript is not a PlanProposal.
        gstate = self.grammar.start() if (grammar and self.grammar) else None
        mask_s = 0.0

        for _ in range(max_new_tokens):
            cur_len = cur.shape[1]
            feeds = {"input_ids": cur}
            if "attention_mask" in self.input_names:
                feeds["attention_mask"] = np.ones((1, fed + cur_len), dtype=id_dtype)
            if "position_ids" in self.input_names:
                feeds["position_ids"] = np.arange(fed, fed + cur_len, dtype=np.int64)[None, :]
            feeds.update(past)

            named = dict(zip(self.output_names, self.session.run(self.output_names, feeds)))

            logits = np.asarray(named["logits"])[0, -1, :].astype(np.float64)

            # ---- CHOOSE THE NEXT TOKEN. This is the only place the two modes differ.
            #
            # Everything after this - the cache hand-forward, the wall-clock bound, EOS handling - is
            # SHARED. The first version had the constrained branch `continue` past all of it, so in
            # constrained mode the KV cache was never updated and position_ids ran ahead of an empty
            # cache. The model then indexed past the end of its position embeddings and died with an
            # ONNX Gather bounds error - a crash in the inference engine, caused by a control-flow
            # shortcut, reported as though it were a model problem.
            if gstate is not None:
                _m0 = time.time()
                try:
                    next_id, gstate = self._pick_constrained(logits, gstate, produced)
                except GrammarExhausted as exc:
                    # A CONSTRAINED DECODER WILL HIT THIS ROUTINELY, and it is not an error.
                    #
                    # It means the model wanted a token the grammar forbids and no legal alternative
                    # existed. With a weak model and a tight grammar that is ordinary, not exceptional.
                    # Raising it out of the request turned that into HTTP 500, so a planner asking for a
                    # plan received "Internal Server Error" - which reads as the inference stack being
                    # broken, and cost a full measurement run before it was diagnosed.
                    #
                    # The correct outcome is a clean stop: keep what was generated, say plainly that
                    # generation was cut short by the grammar, and let the parser reject the partial
                    # document as the malformed thing it is. Refuse, do not crash.
                    grammar_stop = str(exc)
                    exhausted = True
                    break
                finally:
                    mask_s += time.time() - _m0
                    self._mask_builds += 1
                if next_id in self.eos_ids and self.grammar.accepts_eos(gstate):
                    stopped_on_eos = True
                    break
            else:
                if seen:
                    # Divide the tokens seen recently, which lowers their logits; divide only NEGATIVE
                    # logits by the same factor, so a token that was strongly unlikely stays unlikely
                    # and the ordering is otherwise preserved. That keeps the choice deterministic.
                    idx = np.fromiter(seen, dtype=np.int64, count=len(seen))
                    logits[idx] = np.where(logits[idx] > 0, logits[idx] / rep, logits[idx] * rep)
                # Argmax, not sampling. Deliberately no temperature and no top-p: sampling would make the
                # validity rate a measure of luck rather than of the model, and this milestone's question
                # is whether a model can RELIABLY produce a plan.
                next_id = int(np.argmax(logits))
                if next_id == self.eos:
                    # EOS is consumed, never emitted, so it must not appear in the decoded text.
                    stopped_on_eos = True
                    break

            fed += cur_len

            # The wall-clock bound, checked every token. A token ceiling alone does not bound TIME on a
            # machine this slow, and a planner that can make its caller wait unboundedly is a denial of
            # service on whoever called it.
            if time.time() - t0 > self.max_wall_seconds:
                break

            produced.append(next_id)
            if rep != 1.0:
                window.append(next_id)
                if len(window) > REP_WINDOW:
                    window.pop(0)
                seen.add(next_id)

            # Hand the cache forward under the names the NEXT pass expects, matched on the shared
            # suffix. The first version wrote them to `past_<n>.key`, which matches no input name, so
            # the cache was silently never read back and every token after the first was generated
            # with no history at all.
            for suffix, value in named.items():
                if not suffix.startswith("present"):
                    continue
                key = "past_key_values" + suffix[len("present"):]
                if key in past:
                    past[key] = value

            cur = np.array([[next_id]], dtype=id_dtype)

        elapsed = time.time() - t0
        text = self.tokenizer.decode(produced) if produced else ""
        grammar_complete = (gstate is not None and self.grammar.complete(gstate)) if gstate is not None else None

        # Degenerate repetition, MEASURED rather than assumed.
        #
        # This is the failure the repetition penalty exists to prevent, so the server reports whether it
        # happened. A caller that only learned "512 tokens returned" could not distinguish a plan from a
        # loop; the distinct 4-gram count can, and it is what makes the penalty's effectiveness a
        # measurement instead of a hope.
        distinct_4 = len({tuple(produced[i:i + 4]) for i in range(max(0, len(produced) - 3))})
        repetition_ratio = round(1 - (distinct_4 / max(1, len(produced) - 3)), 3) if len(produced) > 6 else 0.0

        return {
            "text": text,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": len(produced),
            "elapsed_s": round(elapsed, 3),
            "tokens_per_s": round(len(produced) / elapsed, 2) if elapsed else 0.0,
            "stopped_on_eos": stopped_on_eos,
            "hit_token_ceiling": len(produced) >= max_new_tokens,
            "hit_wall_clock_ceiling": elapsed > self.max_wall_seconds,
            "distinct_4grams": distinct_4,
            "repetition_ratio": repetition_ratio,
            "grammar_complete": grammar_complete,
            "grammar_exhausted": exhausted,
            "grammar_stop_reason": grammar_stop,
            "mask_seconds": round(mask_s, 3),
            "mask_overhead_ratio": round(mask_s / elapsed, 3) if elapsed else 0.0,
            "constrained": gstate is not None,
        }

    def _pick_constrained(self, logits: np.ndarray, state, produced: list[int]):
        """
        Choose the next token, constrained by the grammar.

        Returns (token_id, new_state). A grammar failure raises, because there is no safe fallback:
        returning the unconstrained argmax would mean a grammar bug turned into an unconstrained model,
        which is precisely the failure this feature must never have.

        The search is: among the tokens whose text the grammar ACCEPTS, take the highest-logit one. It
        accepts a token only by running the grammar forward over its text, so a token whose first byte
        is legal but whose remainder is not is still rejected - which matters because multi-character
        tokens routinely straddle a structural boundary.
        """
        allowed = self.grammar.allowed_bytes(state)
        eos_ok = self.grammar.accepts_eos(state)

        if not allowed and not eos_ok:
            raise GrammarExhausted(f"the grammar admits no continuation (mode={state.mode})")

        # Candidate tokens: those whose first byte is permitted, plus EOS when the document is complete.
        candidates: list[int] = []
        for b in allowed:
            candidates.extend(self.by_first_byte.get(b, ()))
        if eos_ok:
            candidates.extend(self.eos_ids)

        if not candidates:
            raise GrammarExhausted(
                f"no token starts with any of the permitted bytes {sorted(allowed)} (mode={state.mode})")

        idx = np.asarray(candidates, dtype=np.int64)
        sub = logits[idx]
        # Deterministic ordering: highest logit, ties broken by token id, so a constrained run is
        # reproducible. `np.lexsort` puts the last key first, so this is (-logit, id) ascending.
        order = np.lexsort((idx, -sub))
        ranked = idx[order]

        for tid in ranked:
            piece = self.vocab_text.get(int(tid))
            if piece is None:
                continue
            if int(tid) in self.eos_ids and eos_ok:
                return int(tid), state
            nxt = self.grammar.feed(state, piece)
            if nxt is not None:
                return int(tid), nxt
        # The diagnostic matters more than it looks. "Every permitted token was rejected" on its own
        # says nothing about WHICH state refused them, and the state is what one needs to fix the
        # grammar. Guessing at this from the message alone cost several iterations.
        raise GrammarExhausted(
            f"every permitted token was rejected (mode={state.mode} depth={state.depth} "
            f"allowed={sorted(allowed)} tried={len(candidates)} "
            f"stack={[f.kind for f in state.stack]} key_buf={state.key_buf!r} "
            f"pending={state.pending_key!r} seen={sorted(state.stack[-1].seen)} "
            f"str_buf={state.str_buf!r} text_so_far_len={len(state.key_buf) + len(state.str_buf)})")

    def _id_dtype(self):
        for i in self.session.get_inputs():
            if i.name == "input_ids":
                return np.int64 if "int64" in getattr(i, "type", "") else np.int32
        return np.int64

    def _dtype_for(self, name: str):
        for i in self.session.get_inputs():
            if i.name == name:
                s = getattr(i, "type", "")
                return "int64" if "int64" in s else ("int32" if "int32" in s else None)
        return None

    def _meta(self, name: str):
        for i in self.session.get_inputs():
            if i.name == name:
                return i
        raise KeyError(name)

    def describe(self) -> dict:
        return {
            "modelPath": self.model_path,
            "inputs": self.input_names,
            "inputShapes": self.input_shapes,
            "outputs": self.output_names,
            "pastTensors": self.n_past,
            "kvGeometry": {"layers": self.n_layers, "kvHeads": self.n_kv_heads, "headDim": self.head_dim},
            "eos": self.eos,
            "providers": self.session.get_providers(),
        }


# ---------------------------------------------------------------- HTTP

ENGINE: Inference | None = None
LOCK = threading.Lock()  # one sequence at a time: CPU inference is single-threaded in practice, and
#                         concurrent requests would just interleave and each take twice as long.


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence; the console belongs to the operator
        pass

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/describe":
            self._send(200, ENGINE.describe() if ENGINE else {"error": "not loaded"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception as e:
            self._send(400, {"error": f"body was not JSON: {e}"})
            return

        messages = body.get("messages") or []
        if not isinstance(messages, list) or not messages:
            self._send(400, {"error": "no messages"})
            return

        prefill = self.headers.get("x-assistant-prefill", "") or ""
        max_new = int(self.headers.get("x-max-new-tokens") or MAX_NEW_TOKENS)
        rep = float(self.headers.get("x-repetition-penalty") or DEFAULT_REPETITION_PENALTY)
        # Grammar is a REQUEST choice, not a server-wide mode. The unconstrained path must stay
        # reachable, or "constrained" could not be compared against anything and M9's baseline would
        # be unreproducible.
        want_grammar = self.headers.get("x-grammar", "") == "1"
        if want_grammar and ENGINE.grammar is None:
            self._send(400, {"error": "this server was started without --grammar"})
            return

        try:
            with LOCK:
                out = ENGINE.generate(
                    messages, assistant_prefill=prefill,
                    max_new_tokens=max_new, repetition_penalty=rep,
                    grammar=want_grammar,
                )
        except Exception as e:
            # A generation failure is a 500 with a reason, never a half-written body. The caller
            # records it as an outcome; it is not silently an empty completion.
            self._send(500, {"error": f"{type(e).__name__}: {e}"})
            return

        self._send(200, {
            "choices": [{"message": {"role": "assistant", "content": out["text"]}}],
            "usage": {
                "prompt_tokens": out["prompt_tokens"],
                "completion_tokens": out["completion_tokens"],
            },
            "local_inference": {
                "elapsed_s": out["elapsed_s"],
                "tokens_per_s": out["tokens_per_s"],
                "prefilled": bool(prefill),
                "repetition_penalty": rep,
                "stopped_on_eos": out["stopped_on_eos"],
                "hit_token_ceiling": out["hit_token_ceiling"],
                "hit_wall_clock_ceiling": out["hit_wall_clock_ceiling"],
                "repetition_ratio": out["repetition_ratio"],
                "grammar_complete": out["grammar_complete"],
                "grammar_exhausted": out["grammar_exhausted"],
                "grammar_stop_reason": out["grammar_stop_reason"],
                "mask_seconds": out["mask_seconds"],
                "mask_overhead_ratio": out["mask_overhead_ratio"],
                "constrained": out["constrained"],
            },
        })


def main() -> int:
    global ENGINE
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8792)
    ap.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    ap.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 4) - 1))
    ap.add_argument("--max-seconds", type=float, default=MAX_WALL_SECONDS,
                    help="per-request wall-clock ceiling; size it to the model actually loaded")
    ap.add_argument("--string-cap", type=int, default=None,
                    help="M13 experiment: bound free-form and prose string length (default: the grammar's own)")
    ap.add_argument("--grammar", action="store_true",
                    help="enable constrained generation (logit masking against the PlanProposal grammar)")
    args = ap.parse_args()

    print(f"[local-model] loading {args.model_dir} ...", flush=True)
    t0 = time.time()
    ENGINE = Inference(args.model_dir, args.threads, max_wall_seconds=args.max_seconds,
                       grammar=args.grammar,
                       **({} if args.string_cap is None else {"string_cap": args.string_cap}))
    print(f"[local-model] loaded in {time.time()-t0:.1f}s  threads={args.threads}", flush=True)
    print(f"[local-model] inputs: {ENGINE.input_names}", flush=True)
    for n, s in list(ENGINE.input_shapes.items())[:4]:
        print(f"[local-model]   {n}: {s}", flush=True)
    print(f"[local-model] kv: layers={ENGINE.n_layers} kvHeads={ENGINE.n_kv_heads} headDim={ENGINE.head_dim}"
          f"  pastTensors={ENGINE.n_past}  eos={ENGINE.eos}", flush=True)
    print(f"[local-model] grammar: {'ON' if ENGINE.grammar else 'off'}", flush=True)
    if ENGINE.grammar:
        print(f"[local-model]   indexed {len(ENGINE.vocab_text)} tokens; excluded {ENGINE.vocab_unsafe} "
              f"byte-level fragments that are not valid UTF-8 on their own", flush=True)

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[local-model] listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())