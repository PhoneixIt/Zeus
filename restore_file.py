#!/usr/bin/env python3
import subprocess
import os

# Try multiple approaches to get the original orchestrator.ts
src_dir = r'C:\Users\Samer\Projects\AIOS'

# Approach 1: git show
print("=== Approach 1: git show ===")
result = subprocess.run(
    ['git', '-C', src_dir, 'show', 'HEAD:packages/agent/orchestrator.ts'],
    capture_output=True, text=True, timeout=30
)
print(f"Return code: {result.returncode}")
print(f"Output size: {len(result.stdout) if result.stdout else 0}")
if result.stdout:
    print(f"First 100 chars: {result.stdout[:100]}")
    # Check if it has normalizedFindings
    if 'normalizedFindings' in result.stdout:
        print("Has normalizedFindings - good!")
    else:
        print("Does NOT have normalizedFindings")

# Approach 2: Check if file exists in working dir and try to read it
print("\n=== Approach 2: Working dir file ===")
fpath = os.path.join(src_dir, 'packages', 'agent', 'orchestrator.ts')
if os.path.exists(fpath):
    fsize = os.path.getsize(fpath)
    print(f"File exists, size: {fsize}")
    # Read first few lines
    with open(fpath, 'r') as f:
        lines = f.readlines()[:10]
    print(f"First 10 lines:")
    for i, line in enumerate(lines):
        print(f"  Line {i+1}: {lines[i][:80]}")

# Approach 3: Check all git branches
print("\n=== Approach 3: Git log ===")
result = subprocess.run(
    ['git', '-C', src_dir, 'log', '--oneline', '-5', '--all'],
    capture_output=True, text=True, timeout=30
)
print(f"Return code: {result.returncode}")
print(f"Output: {result.stdout[:200] if result.stdout else 'no output'}")

# Approach 4: git reflog
print("\n=== Approach 4: git reflog ===")
result = subprocess.run(
    ['git', '-C', src_dir, 'reflog', 'show', 'HEAD'],
    capture_output=True, text=True, timeout=30
)
print(f"Return code: {result.returncode}")
print(f"Output: {result.stdout[:200] if result.stdout else 'no output'}")
PYEOF