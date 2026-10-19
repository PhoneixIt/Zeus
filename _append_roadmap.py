import io

target = r'C:\Users\Samer\Projects\AIOS\docs\ROADMAP.md'
addition = r'C:\Users\Samer\Projects\AIOS\_append_roadmap.md'

before = io.open(target, encoding='utf-8').read()
n_before = before.count('\n')
add = io.open(addition, encoding='utf-8').read()

assert 'PHASE 4 ENTRY PLAN' not in before, 'already appended - refusing to duplicate'
with io.open(target, 'a', encoding='utf-8') as f:
    f.write(add)

after = io.open(target, encoding='utf-8').read()
assert after.startswith(before), 'PREFIX CHANGED - abort'
print('ROADMAP.md: lines %d -> %d (prefix intact)' % (n_before, after.count('\n')))