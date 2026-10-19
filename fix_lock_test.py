with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    content = f.read()

# Fix the stale LOCK test - ensure proper line break between assertion and rmSync
old = "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\n  rmSync"
new = "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\n\n  rmSync"

if old in content:
    content = content.replace(old, new)
    print('Fixed line break between assertion and rmSync')
else:
    print('Pattern not found')
    # Show what's around the assertion
    idx = content.find("assert.equal(second.holder")
    if idx >= 0:
        print(content[idx:idx+100])

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.write(content)
print("Done")