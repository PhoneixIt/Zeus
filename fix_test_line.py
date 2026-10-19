#!/usr/bin/env python3
import sys

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    content = f.read()

# The problematic section is around the stale LOCK test assertion
# We need to ensure proper line breaks for TypeScript parsing

# Find the exact string and replace with proper formatting
old = "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\r\\n  rmSync(p + '.lock', { force: true })"
replacement = """assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))
  rmSync(p + '.lock', { force: true })"""

if old in content:
    content = content.replace(old, replacement)
    print('Fixed using old pattern')
elif 'assert.equal(second.holder, ' in content:
    # Try alternative pattern
    idx = content.find("assert.equal(second.holder")
    print('Found assertion at', idx)
    # Show context
    print('Context:', repr(content[idx:idx+80]))
else:
    print('assert.equal not found')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.write(content)
print("Done")