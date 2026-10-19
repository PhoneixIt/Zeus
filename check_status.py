#!/usr/bin/env python3
import subprocess
import os

# Check git status
result = subprocess.run(
    ['git', '-C', 'C:\\Users\\Samer\\Projects\\AIOS', 'status'],
    capture_output=True, text=True
)
print("=== GIT STATUS ===")
print(result.stdout)
print("RETURN CODE:", result.returncode)

# List modified and untracked files
result2 = subprocess.run(
    ['git', '-C', 'C:\\Users\\Samer\\Projects\\AIOS', 'status', '--porcelain'],
    capture_output=True, text=True
)
print("\n=== MODIFIED/UNTRACKED FILES ===")
print(result2.stdout)
PYEOF