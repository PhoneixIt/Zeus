with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    content = f.read()

# Find and fix the stale LOCK test assertion
# The problematic line has: 'stale lock from pid ' + String(process.pid))\n
# We need to fix the newline placement

old = \"assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync\"
new = \"assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync\"

if old in content:
    content = content.replace(old, new)
    print('Fixed newline placement')
else:
    print('Pattern not found')
    # Show what's around line 255
    idx = content.find('assert.equal(second.holder')
    if idx >= 0:
        print(content[idx:idx+150])

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.write(content)
print("Done")