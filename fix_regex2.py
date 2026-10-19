#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Fix the regex line - add the opening parenthesis
# Current (broken): .replace([^a-z0-9\s]/g, '')
# Correct: .replace(/[^a-z0-9\s]/g, '')

# Find and replace the broken line
old = '    .replace([^a-z0-9\\s]/g, \"\")'
new = '    .replace(/[^a-z0-9\\s]/g, \"\")'

print('Looking for:', repr(old))
print('In content:', old in content)

if old in content:
    content = content.replace(old, new)
    print('Replaced the regex line')
else:
    print('Pattern not found, showing context...')
    idx = content.find('.replace([^a-z')
    if idx >= 0:
        print('Found at index', idx)
        print('Context:', content[idx:idx+40])

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(content)
print('Done')