with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    content = f.read()

# Replace the assert line with template literal
old = "  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))"
new = "  assert.equal(second.holder, `stale lock from pid ${String(process.pid)}`)"

if old in content:
    content = content.replace(old, new)
    print('Template literal fixed')
else:
    print('Pattern not found')
    # Show what's around the pattern
    idx = content.find(old)
    if idx >= 0:
        print(content[idx:idx+100])

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.write(content)
print("Done")