import io

target = r'C:\Users\Samer\Projects\AIOS\docs\safety\known-defects.md'
addition = r'C:\Users\Samer\Projects\AIOS\_m_a_doc_add.md'

before = io.open(target, encoding='utf-8').read()
n_before = before.count('\n')
add = io.open(addition, encoding='utf-8').read()

assert 'RESOLVED \u2014 M-a, 2026-10-11' not in before, 'already appended - refusing to duplicate'
# The entry being resolved must still be present, verbatim, before we append.
assert 'the round-budget exhaustion test is MISSING, not broken (open)' in before

with io.open(target, 'a', encoding='utf-8') as f:
    f.write('\n' + add)

after = io.open(target, encoding='utf-8').read()
assert after.startswith(before), 'PREFIX CHANGED - abort'
assert 'the round-budget exhaustion test is MISSING, not broken (open)' in after, 'prior entry lost'
assert 'RESOLVED \u2014 M-a, 2026-10-11' in after, 'append missing'

print('known-defects.md: lines %d -> %d  (append-only, prefix intact, prior entry verbatim)' % (
    n_before, after.count('\n')))