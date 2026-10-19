#!/usr/bin/env python3
import sys

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

print("=== normalizedFindings function (lines 75-88) ===")
for i in range(75, 90):
    if i <= len(lines):
        print(f"Line {i+1}: {lines[i].rstrip()}")

print("\n=== evidenceFingerprint function ===")
for i, line in enumerate(lines):
    if 'evidenceFingerprint' in line:
        start = max(0, i-2)
        end = min(len(lines), i+8)
        for j in range(start, end):
            print(f"Line {j+1}: {lines[j].rstrip()}")
        print("---")
        break

print("\n=== FRESH BUT UNRESOLVABLE test ===")
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    test_lines = f.readlines()
for i in range(110, 140):
    if i <= len(test_lines):
        print(f"Test line {i}: {test_lines[i-1].rstrip()}")