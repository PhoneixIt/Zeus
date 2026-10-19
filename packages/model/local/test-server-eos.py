"""
Controls for the model's EOS / stop-token resolution.

The defect these exist for: the server resolved EOS by asking the tokenizer for two special-token
strings that were EMPTY in these model files. `tokenizer_config.json` says `"eos_token": ""`, so
`token_to_id("")` quietly returned a plausible integer (the BOS) and the server started up reporting
a stop token that was never the chat stop token. Generation keyed on that stops on the wrong event,
and the symptom - output that rambles past every turn boundary - reads exactly like "the model is
too weak". It was a configuration bug.

These controls use the REAL resolver against synthetic and real configurations. No model is loaded,
so they are fast, and none of them hardcodes a token id to make an assertion pass: ids come from the
config dict under test.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import resolve_stop_ids, resolve_stop_ids_from_dir  # noqa: E402

CHECKS = []


def check(ok: bool, msg: str) -> None:
    CHECKS.append((bool(ok), msg))


# ============================================================================================
# VALID CONFIGURATION
# ============================================================================================

# A scalar id, the ordinary case.
ids, src = resolve_stop_ids({"eos_token_id": 151645, "vocab_size": 151936})
check(ids == {151645}, "a scalar eos_token_id is resolved")
check(src == "config.json:eos_token_id", "the source names where the id came from")

# A list of ids, which models with several stop tokens declare.
ids, _ = resolve_stop_ids({"eos_token_id": [11, 22, 33], "vocab_size": 100})
check(ids == {11, 22, 33}, "a LIST of eos_token_ids is accepted in full")

# No vocab_size declared: the range check cannot be applied, so the id is taken on its own terms.
ids, _ = resolve_stop_ids({"eos_token_id": 7})
check(ids == {7}, "an id is accepted when vocab_size is not declared")

# The real thing, read from the real model on disk.
REAL = os.path.join(os.environ.get("LOCALAPPDATA", ""), "AIOS", "models", "qwen2.5-0.5b-instruct")
if os.path.isdir(REAL):
    with open(os.path.join(REAL, "config.json"), "r", encoding="utf-8") as f:
        real_cfg = json.load(f)
    real_ids, real_src = resolve_stop_ids(real_cfg)
    declared = real_cfg.get("eos_token_id")
    check(real_ids == {declared},
          "the model on disk resolves to exactly the id its config.json declares")
    check(declared in real_ids and declared >= 0,
          "the resolved stop token is a real, non-negative id")
    check(real_ids and max(real_ids) < real_cfg.get("vocab_size", 1 << 30),
          "the resolved stop token is inside the declared vocabulary")

    # This model's tokenizer_config names a real special token, and the resolution must agree with
    # config.json. The agreement is the point: two independent declarations of the same stop token.
    with open(os.path.join(REAL, "tokenizer_config.json"), "r", encoding="utf-8") as f:
        tok_cfg = json.load(f)
    tok_eos = tok_cfg.get("eos_token")
    check(isinstance(tok_eos, str) and tok_eos == "<|im_end|>",
          f"CONTROL: this model declares its chat stop token as {tok_eos!r}")
    ids_from_dir, src_dir = resolve_stop_ids_from_dir(REAL)
    check(ids_from_dir == real_ids,
          "the tokenizer's own declaration and config.json resolve to the SAME stop token")
    check("+tokenizer" in src_dir or "config.json" in src_dir,
          "the source records that a declaration was consulted")

    # A tokenizer declaration of something the tokenizer cannot resolve must not invent a stop token.
    with tempfile.TemporaryDirectory() as d2:
        with open(os.path.join(d2, "config.json"), "w", encoding="utf-8") as f:
            json.dump(real_cfg, f)
        with open(os.path.join(d2, "tokenizer_config.json"), "w", encoding="utf-8") as f:
            json.dump({"eos_token": "<|not_a_real_token|>"}, f)
        ids_bogus, _ = resolve_stop_ids_from_dir(d2)
        check(ids_bogus == real_ids,
              "an unresolvable tokenizer eos_token does not disturb the config's stop token")

# ============================================================================================
# MISSING / NULL
# ============================================================================================

for label, cfg in [
    ("no eos_token_id at all", {"vocab_size": 100}),
    ("eos_token_id is null", {"eos_token_id": None, "vocab_size": 100}),
    ("eos_token_id is an empty string", {"eos_token_id": "", "vocab_size": 100}),
    ("eos_token_id is an empty list", {"eos_token_id": [], "vocab_size": 100}),
    ("eos_token_id is whitespace", {"eos_token_id": "   ", "vocab_size": 100}),
    ("eos_token_id is a float", {"eos_token_id": 151645.0, "vocab_size": 100}),
    ("eos_token_id is a string", {"eos_token_id": "151645", "vocab_size": 100}),
    ("the whole config is empty", {}),
]:
    ids, src = resolve_stop_ids(cfg)
    check(not ids, f"NEGATIVE: REFUSED when {label} (got {sorted(ids)})")
    check(src == "none", f"NEGATIVE: the refusal reports no source when {label}")

# ============================================================================================
# INVALID
# ============================================================================================

ids, _ = resolve_stop_ids({"eos_token_id": -1, "vocab_size": 100})
check(not ids, "NEGATIVE: a NEGATIVE eos_token_id is refused")

ids, _ = resolve_stop_ids({"eos_token_id": 100, "vocab_size": 100})
check(not ids, "NEGATIVE: an id EQUAL to vocab_size is refused (out of range)")

ids, _ = resolve_stop_ids({"eos_token_id": 999999, "vocab_size": 100})
check(not ids, "NEGATIVE: an id far beyond vocab_size is refused")

ids, _ = resolve_stop_ids({"eos_token_id": True, "vocab_size": 100})
check(not ids, "NEGATIVE: a BOOLEAN is refused even though Python treats True as the int 1")

# An out-of-range id in a LIST is dropped, and a good sibling survives.
ids, _ = resolve_stop_ids({"eos_token_id": [5, 999999], "vocab_size": 100})
check(ids == {5}, "a list drops only the out-of-range entry and keeps the usable one")

# Every entry bad -> refused, not partially honoured.
ids, _ = resolve_stop_ids({"eos_token_id": [-1, 999999], "vocab_size": 100})
check(not ids, "NEGATIVE: a list of nothing but invalid ids is refused outright")

# ============================================================================================
# A DIRECTORY WITH NO USABLE CONFIGURATION MUST REFUSE
# ============================================================================================

with tempfile.TemporaryDirectory() as d:
    with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"vocab_size": 100}, f)          # no eos_token_id at all
    with open(os.path.join(d, "tokenizer_config.json"), "w", encoding="utf-8") as f:
        json.dump({"eos_token": ""}, f)            # blank, as in the real model
    ids, _ = resolve_stop_ids_from_dir(d)
    check(not ids, "NEGATIVE: a model directory with neither declaration REFUSES to start")

with tempfile.TemporaryDirectory() as d:
    with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"eos_token_id": 42, "vocab_size": 100}, f)
    ids, _ = resolve_stop_ids_from_dir(d)
    check(ids == {42}, "a model directory declaring a valid eos_token_id is accepted")

with tempfile.TemporaryDirectory() as d:
    ids, _ = resolve_stop_ids_from_dir(d)          # no files at all
    check(not ids, "NEGATIVE: an empty directory REFUSES rather than defaulting")


# ============================================================================================

def main() -> int:
    passed = sum(1 for ok, _ in CHECKS if ok)
    for ok, msg in CHECKS:
        print(f"  {'PASS' if ok else 'FAIL'}  {msg}")
    print()
    print(f"=== {passed}/{len(CHECKS)} eos controls ===")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())