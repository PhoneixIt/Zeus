#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Replace the regex in normalizedFindings function
# The current regex strips digits: .replace(/[^a-z\s]/g, '')
# Change to: .replace(/[^a-z0-9\s]/g, '') to preserve digits
old = "    .replace(/[^a-z\\s]/g, \"\")"
new = "    .replace(/[^a-z0-9\\s]/g, \"\")"

print('Old pattern:', repr(old))
print('New pattern:', repr(new))

if old in content:
    content = content.replace(old, new)
    print('Replaced the regex line')
else:
    # Try the exact string from the file
    old2 = "    .replace(/[^a-z\s]/g, \"\")"
    if old2 in content:
        content = content.replace(old2, new)
        print('Replaced with alternative exact pattern')
    else:
        print('Could not find the pattern to replace')
        # Show what's at line 82
        lines = content.split('\n')
        for i in range(80, 85):
            if i < len(lines):
                print(f'Line {i+1}: {repr(lines[i])}')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(content)
print('Done')