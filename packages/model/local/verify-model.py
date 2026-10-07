r"""
INTEGRITY CHECK FOR THE LOCAL MODEL. Load it, inspect its real I/O signature, run a generation.

This is the verification step, and it exists because a corrupt 488 MB file would not announce itself.
onnxruntime fails loudly on a truncated graph, which is good; what it does NOT tell us is whether the
generate loop we wrote feeds the cache back under the right NAMES. So this prints the actual input and
output names and compares them against the assumption the decode loop makes.

The last check is the one that matters: does the model produce COHERENT text for a trivial prompt? A
broken cache produces fluent-looking noise, and "it produced text" is not evidence of anything. So the
model is asked something whose answer is known and short.
"""

import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                         "AIOS", "models",
                         sys.argv[1] if len(sys.argv) > 1 else "qwen2.5-0.5b-instruct")


def main() -> int:
    path = os.path.join(MODEL_DIR, "model.onnx")
    size = os.path.getsize(path)
    print(f"=== 1. FILE ===")
    print(f"  path        {path}")
    print(f"  size        {size} bytes ({size // (1024*1024)} MB)")

    # A truncated download has almost the right size and no graph. Reading the first and last bytes
    # catches the two cheap failures - a wrong file, and a download that stopped early - before the
    # expensive parse.
    with open(path, "rb") as f:
        head = f.read(8)
        f.seek(-8, os.SEEK_END)
        tail = f.read(8)
    print(f"  first bytes {head!r}   (ONNX graphs are protobuf; they do not start with a magic number)")
    print(f"  last bytes  {tail!r}")

    print(f"\n=== 2. LOAD ===")
    t0 = time.time()
    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    load_s = time.time() - t0
    print(f"  session built in {load_s:.1f}s")
    print(f"  providers   {sess.get_providers()}")

    inputs = sess.get_inputs()
    outputs = sess.get_outputs()
    names = [i.name for i in inputs]

    print(f"\n=== 3. I/O SIGNATURE (what the decode loop must match) ===")
    print(f"  {len(inputs)} inputs, {len(outputs)} outputs")
    for i in inputs[:4]:
        print(f"    in  {i.name}: {list(i.shape)}  type={i.type}")
    if len(inputs) > 6:
        print(f"    ... ({len(inputs) - 6} more, all past_key_values.*)")
        print(f"    in  {inputs[-1].name}: {list(inputs[-1].shape)}  type={inputs[-1].type}")
    print(f"    out logits: {[o.name for o in outputs if o.name == 'logits']}")
    presents = [o.name for o in outputs if o.name.startswith("present")]
    print(f"    {len(presents)} present.* outputs, e.g. {presents[:2]}")

    print(f"\n=== 4. THE ASSUMPTION THE DECODE LOOP MAKES ===")
    past_in = [n for n in names if "past_key_values" in n]
    print(f"  past input prefix   'past_key_values'  ({len(past_in)} tensors)")
    print(f"  present output prefix 'present'         ({len(presents)} tensors)")
    print(f"  suffix match: every input suffix has a matching output suffix: "
          f"{all(('present' + n[len('past_key_values'):]) in presents for n in past_in)}")
    missing = [n for n in past_in if ("present" + n[len("past_key_values"):]) not in presents]
    if missing:
        print(f"  MISMATCH - these inputs have no matching output: {missing[:4]}")
        return 1
    print(f"  position_ids present: {'position_ids' in names}")
    print(f"  attention_mask present: {'attention_mask' in names}")

    print(f"\n=== 5. KV GEOMETRY FROM config.json ===")
    cfg = json.load(open(os.path.join(MODEL_DIR, "config.json"), encoding="utf-8"))
    n_layers = cfg["num_hidden_layers"]
    n_kv = cfg["num_key_value_heads"]
    head_dim = cfg.get("head_dim") or cfg["hidden_size"] // cfg["num_attention_heads"]
    print(f"  layers={n_layers}  kvHeads={n_kv}  headDim={head_dim}  "
          f"(expected past tensors = {n_layers * 2}, graph has {len(past_in)})")
    if len(past_in) != n_layers * 2:
        print(f"  MISMATCH: the graph's tensor count disagrees with config.json")
        return 1

    print(f"\n=== 6. THE CHECK THAT MATTERS: is the output coherent? ===")
    tok = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
    eos = tok.token_to_id("<|im_end|>")
    print(f"  eos <|im_end|> = {eos}   (config.json says {cfg['eos_token_id']})")
    if eos != cfg["eos_token_id"]:
        print(f"  NOTE: the server prefers the tokenizer's id; they differ, which is worth knowing")

    prompt = ("<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n"
              "<|im_start|>user\nWhat is the capital of France? Answer in one word.<|im_end|>\n"
              "<|im_start|>assistant\n")
    ids = list(tok.encode(prompt).ids)
    print(f"  prompt: {len(ids)} tokens")
    print(f"  ...{prompt[-90:]!r}")

    id_dtype = np.int64 if "int64" in inputs[0].type else np.int32
    past = {n: np.zeros((1, n_kv, 0, head_dim), dtype=np.float32) for n in past_in}
    cur = np.array([ids], dtype=id_dtype)
    fed = 0
    produced = []
    t0 = time.time()
    first_token_s = None
    iters = 0

    for _ in range(40):
        iters += 1
        feeds = {"input_ids": cur}
        clen = cur.shape[1]
        if "attention_mask" in names:
            feeds["attention_mask"] = np.ones((1, fed + clen), dtype=id_dtype)
        if "position_ids" in names:
            feeds["position_ids"] = np.arange(fed, fed + clen, dtype=np.int64)[None, :]
        feeds.update(past)

        named = dict(zip([o.name for o in outputs], sess.run([o.name for o in outputs], feeds)))
        if first_token_s is None:
            first_token_s = time.time() - t0

        nxt = int(np.argmax(np.asarray(named["logits"])[0, -1, :].astype(np.float64)))
        fed += clen
        if nxt == eos:
            break
        produced.append(nxt)
        for suffix, val in named.items():
            if suffix.startswith("present"):
                key = "past_key_values" + suffix[len("present"):]
                if key in past:
                    past[key] = val
        cur = np.array([[nxt]], dtype=id_dtype)

    elapsed = time.time() - t0
    text = tok.decode(produced) if produced else ""
    print(f"  generated {len(produced)} tokens in {elapsed:.2f}s  "
          f"({len(produced)/elapsed if elapsed else 0:.1f} tok/s)")
    print(f"  first token after {first_token_s:.2f}s")
    print(f"  ANSWER: {text!r}")

    # "Paris" is the answer a model of this class gives. Coherence is the signal: a broken KV cache
    # still returns text, just nonsense, so the check has to be about sense rather than non-emptiness.
    if "Paris" in text:
        print(f"\n  VERDICT: COHERENT. The cache is being read back correctly, and the decode loop is sound.")
        return 0
    print(f"\n  VERDICT: NOT COHERENT. The output is not an answer to the question.")
    print(f"          This is a decode-loop or model-load fault, NOT a finding about planning.")
    return 1


if __name__ == "__main__":
    sys.exit(main())