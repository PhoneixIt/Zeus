#!/usr/bin/env python3
import subprocess
import sys

test_file = r"C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts"
node_cmd = "node --experimental-strip-types --no-warnings"

try:
    result = subprocess.run(
        [node_cmd, test_file],
        capture_output=True,
        text=True,
        timeout=120
    )
    print(f"Exit code: {result.returncode}")
    print(f"Stdout length: {len(result.stdout)}")
    print(f"Stderr length: {len(result.stderr)}")
    # Print first 2000 chars of stdout
    print("Stdout:", result.stdout[:2000] if result.stdout else "empty")
    print("Stderr:", result.stderr[:2000] if result.stderr else "empty")
except Exception as e:
    print(f"Exception: {type(e).__name__}: {e}")