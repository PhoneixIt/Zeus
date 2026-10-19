#!/usr/bin/env python3
import subprocess
import sys

test_file = r"C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts"
node_cmd = ["node", "--experimental-strip-types", "--no-warnings", "--test", test_file]

try:
    result = subprocess.run(node_cmd, capture_output=True, text=True, timeout=120)
    print(f"Exit code: {result.returncode}")
    print(f"Stdout length: {len(result.stdout)}")
    print(f"Stderr length: {len(result.stderr)}")
    print("=== STDOUT ===")
    print(result.stdout[:3000] if result.stdout else "empty")
    print("=== STDERR ===")
    print(result.stderr[:3000] if result.stderr else "empty")
except Exception as e:
    print(f"Exception: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()