#!/usr/bin/env python3
import subprocess
import sys

# Try running the convergence test directly
test_file = r"C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts"

# Use node to run the test
try:
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--no-warnings", "--test", test_file],
        capture_output=True,
        text=True,
        timeout=120000
    )
    print("STDOUT:", result.stdout[-3000:] if result.stdout else "")
    print("STDERR:", result.stderr[-3000:] if result.stderr else "")
    print(f"Exit code: {result.returncode}")
except Exception as e:
    print(f"Exception: {e}")
" > run_test.py