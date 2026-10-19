#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# The regex in the file is: /[^a-z\s]/g
# We want to change it to: /[^a-z0-9\s]/g
# In the Python string, the file contains: [^a-z\s]
# But when Python reads it, the \\s becomes \s in the actual string

# Let me just do a string replacement on the specific regex text
old = "/[^a-z\\s]/g"
new = "[^a-z0-9\\s]/g"

print('Looking for:', repr(old))
print('In content:', old in content)

if old in content:
    content = content.replace(old, new)
    print('Replaced regex')
else:
    print('Pattern not found')
    # Try the exact string from the file
    idx = content.find('/[^a-z')
    if idx >= 0:
        print('Found at index', idx)
        print('Context:', content[idx:idx+30])

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(content)
print('Done')