with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    lines = f.readlines()

# Revert line 255 (index 254) to simple string concatenation
lines[254] = '  assert.equal(second.holder, \'stale lock from pid \' + String(process.pid))\\n'

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.writelines(lines)
print('Reverted to string concatenation')