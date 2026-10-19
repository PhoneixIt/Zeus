with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    lines = f.readlines()

# Fix the stale LOCK test assertion at line 255 (0-based index 254)
# Change: assert.equal(second.holder, String(process.pid), ...)
# To: assert.equal(second.holder, 'stale lock from pid ' + String(process.pid), ...)

# Line numbers: the test file is 1-indexed in the error, so line 255 is index 254
idx = 254  # zero-based index for line 255
old = "assert.equal(second.holder, String(process.pid), 'a second orchestrator must not take a held lock')"
new = "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid), 'a second orchestrator must not take a held lock')"

if lines[idx] == old or old.rstrip() in lines[idx]:
    lines[idx] = new + '\n'
    print(f'Fixed stale LOCK test at line {idx+1}')
else:
    print('Pattern not found, current line:')
    print(repr(lines[idx]))

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.writelines(lines)
print("Done")