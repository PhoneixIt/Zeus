#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Line 82 (index 81) needs to change the regex
# Current: '    .replace([^a-z0-9\s]/g, ")'
# Need: '    .replace(/[^a-z0-9\s]/g, ")'

# The actual content of line 82 is:
# '    .replace([^a-z0-9\s]/g, "")\n'
# We need to change it to: '    .replace(/[^a-z0-9\s]/g, "")\n'

# Find the exact string and replace
old = '    .replace([^a-z0-9\s]/g, "")\n'
new = '    .replace(/[^a-z0-9\s]/g, "")\n'

if lines[81] == old:
    lines[81] = new
    print('Replaced line 82')
else:
    print('Line 82 does not match:', repr(lines[81]))

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(lines)
print('Done')