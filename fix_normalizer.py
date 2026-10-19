#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Replace the regex in normalizedFindings function
# The current regex strips digits: .replace(/[^a-z\s]/g, '')
# Change to: .replace(/[^a-z0-9\s]/g, '') to preserve digits
old = "    .replace(/[^a-z\\s]/g, \"\")"
new = "    .replace(/[^a-z0-9\\s]/g, \"\")"

if old in content:
    content = content.replace(old, new)
    print('Fixed normalizedFindings regex')
else:
    # Try alternative pattern match
    print('Pattern not found, checking context...')
    idx = content.find('replace(/[^a-z')
    if idx >= 0:
        print('Found at index', idx)
        print('Context:', content[idx:idx+50])
    else:
        print('Pattern not found at all')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(content)
print('Done')