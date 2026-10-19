with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    lines = f.readlines()

# Fix the stale LOCK test assertion at line 255 (0-based index 254)
# Current: '  assert.equal(second.holder, String.process.pid)\n'
# Change to: '  assert.equal(second.holder, "stale lock from pid " + String(process.pid))\n'

idx = 254  # zero-based index for line 255
old = "  assert.equal(second.holder, String(process.pid))"
new = "  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))"

if lines[idx] == old:
    lines[idx] = new + '\n'
    print(f'Fixed stale LOCK test at line {idx+1}')
else:
    print('Pattern not exactly matching, current:')
    print(repr(lines[idx]))

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.writelines(lines)
print("Done")