import io

target = r'C:\Users\Samer\Projects\AIOS\docs\safety\known-defects.md'
addition = r'C:\Users\Samer\Projects\AIOS\_append_defect.md'

before = io.open(target, encoding='utf-8').read()
n_before = before.count('\n')
add = io.open(addition, encoding='utf-8').read()

assert 'the round-budget exhaustion test is MISSING' not in before, 'already appended'
with io.open(target, 'a', encoding='utf-8') as f:
    f.write(add)

after = io.open(target, encoding='utf-8').read()
assert after.startswith(before), 'PREFIX CHANGED - abort'
print('known-defects.md: lines %d -> %d (prefix intact)' % (
    n_before, after.count('\n')))