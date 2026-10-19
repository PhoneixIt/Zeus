#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Line 82 (0-based index 81) has the regex
# Current: '    .replace(/[^a-z\s]/g, ")'
# Need: '    .replace(/[^a-z0-9\s]/g, ")'

old_line = "    .replace(/[^a-z\s]/g, \")"
new_line = "    .replace(/[^a-z0-9\s]/g, \")"

# Check if the old line matches
if lines[81] == old_line:
    lines[81] = new_line
    print('Replaced line 82')
else:
    print('Line 82 does not match expected value')
    print('Current line 82:', repr(lines[81]))

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(lines)
print('Done')