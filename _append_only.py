import io

target = r'C:\Users\Samer\Projects\AIOS\docs\EVIDENCE.md'
addition = r'C:\Users\Samer\Projects\AIOS\_append_phase3_evidence.md'

before = io.open(target, encoding='utf-8').read()
n_before = before.count('\n')
add = io.open(addition, encoding='utf-8').read()

# Append only. Never rewrite what is there.
assert 'PHASE 3 — ORCHESTRATOR CONVERGENCE' not in before, 'already appended - refusing to duplicate'
with io.open(target, 'a', encoding='utf-8') as f:
    f.write(add)

after = io.open(target, encoding='utf-8').read()
assert after.startswith(before), 'PREFIX CHANGED - abort'
print('EVIDENCE.md: lines %d -> %d (appended %d, prefix intact)' % (
    n_before, after.count('\n'), after.count('\n') - n_before))