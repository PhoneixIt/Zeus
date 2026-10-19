#!/usr/bin/env python3
import sys

with open('packages/agent/orchestrator.ts', 'r') as f:
    content = f.read()

# Find and replace the second fp declaration
old = "    const fp = review ? normalizedFindings(review.text) : ''"
new = "    const reviewFp = review ? normalizedFindings(review.text) : ''"

if old in content:
    content = content.replace(old, new)
    with open('packages/agent/orchestrator.ts', 'w') as f:
        f.write(content)
    print("Fixed!")
else:
    print("Old string not found")
    # Show what's around line 500
    lines = content.split('\n')
    for i in range(495, 510):
        print(f"Line {i+1}: {lines[i][:80]}")