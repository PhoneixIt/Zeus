"""
Fetch a local model from HuggingFace, with resume and retry.

Written after two real failures, both of which a naive downloader would have turned into a lost hour:

  * a shell restart killed a 327 MB transfer, and the partial file was the only thing that survived
  * a connection reset (WinError 10054) killed a 1165 MB transfer after 2 MB

So: resume on every attempt, refuse to append when the server ignores Range (which would produce a
corrupt file of plausible length), and retry with backoff. Every retry is a RESUME, never a restart.

The model directory is outside the repository. Weights are large, are not source, and would otherwise
need a gitignore entry that could be got wrong.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

CHUNK = 1 << 20
REPORT_EVERY = 64 << 20

MODELS = {
    "qwen2.5-0.5b-instruct": {
        "repo": "onnx-community/Qwen2.5-0.5B-Instruct",
        "weights": "onnx/model_quantized.onnx",
    },
    "qwen2.5-1.5b-instruct": {
        "repo": "onnx-community/Qwen2.5-1.5B-Instruct",
        "weights": "onnx/model_q4f16.onnx",
    },
}

SIDECARS = ["tokenizer.json", "tokenizer_config.json", "config.json"]


def dest_dir(name: str) -> str:
    return os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "AIOS", "models", name
    )


def fetch(base: str, remote: str, path: str, attempts: int = 60) -> int:
    tmp = path + ".partial"

    for attempt in range(1, attempts + 1):
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return os.path.getsize(path)

        offset = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        req = urllib.request.Request(f"{base}{remote}")
        if offset:
            req.add_header("Range", f"bytes={offset}-")

        try:
            r = urllib.request.urlopen(req, timeout=180)
        except Exception as e:
            # Deliberately BROAD. Two real transfers died on exceptions this narrow clause missed: a
            # ConnectionResetError (an OSError, caught) and a socket TimeoutError raised mid-read, which
            # is neither an URLError nor a ConnectionError and escaped, killing the fetcher at 342 MB of
            # 1165. Catching every exception here is correct because this is the retry boundary: an
            # unexpected exception is still a reason to RESUME, never a reason to abandon the file.
            # The fatal case - a server ignoring Range - raises SystemExit above and is not an Exception
            # subclass, so it still stops the loop rather than retrying forever.
            #
            # A reset mid-transfer is routine on a 1 GB file. Resume, do not restart: the bytes already
            # on disk are the expensive part, and throwing them away on every blip is what turns one
            # flaky network into an impossible task.
            have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
            backoff = min(60, 2 ** attempt)
            print(f"    attempt {attempt} failed at {have // (1 << 20)} MB: {e}", flush=True)
            print(f"    resuming from {have // (1 << 20)} MB in {backoff}s", flush=True)
            time.sleep(backoff)
            continue

        # A server that IGNORES Range replies 200 with the whole body. Appending that to a partial
        # prefix yields a corrupt file of plausible length - which would later be misdiagnosed as
        # "the model produces nonsense" rather than a broken download.
        status = getattr(r, "status", r.getcode())
        if offset and status != 206:
            r.close()
            raise SystemExit(
                f"  {remote}: the server ignored Range (HTTP {status}); refusing to append a whole body "
                f"to a {offset}-byte prefix. Delete {tmp} to start over."
            )

        declared = int(r.headers.get("Content-Length") or 0)
        expected = offset + declared
        total = offset
        last = offset
        print(f"    {offset // (1 << 20)} MB of {expected // (1 << 20)} MB", flush=True)

        with r, open(tmp, "ab" if offset else "wb") as f:
            while True:
                chunk = r.read(CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
                if total - last >= REPORT_EVERY:
                    pct = f"{total * 100 // expected}%" if expected else "?"
                    print(f"    {pct} ({total // (1 << 20)} MB)", flush=True)
                    last = total

        if expected and total != expected:
            print(f"    short read: {total} of {expected}; resuming", flush=True)
            continue

        os.replace(tmp, path)
        return total

    raise SystemExit(f"  {remote}: gave up after {attempts} attempts; the partial file is kept")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen2.5-0.5b-instruct", choices=sorted(MODELS))
    args = ap.parse_args()

    spec = MODELS[args.model]
    dest = dest_dir(args.model)
    os.makedirs(dest, exist_ok=True)
    base = f"https://huggingface.co/{spec['repo']}/resolve/main/"
    print(f"model:  {args.model}")
    print(f"repo:   {spec['repo']}")
    print(f"into:   {dest}", flush=True)

    try:
        for remote, local in [(spec["weights"], "model.onnx")] + [(s, s) for s in SIDECARS]:
            size = fetch(base, remote, os.path.join(dest, local))
            print(f"  {local}: {size} bytes", flush=True)
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return 1

    with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"model": args.model, "repo": spec["repo"], "revision": "main",
                   "weights": spec["weights"]}, f, indent=2)
    print("  manifest written", flush=True)
    print("  Integrity is established by verify-model.py, which loads it and runs inference.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())