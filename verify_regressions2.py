import io, subprocess, re

REPO = r'C:\Users\Samer\Projects\AIOS'
TARGET = REPO + r'\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'

def run(pattern):
    r = subprocess.run(
        ['node', '--experimental-strip-types', '--no-warnings', '--test', TEST,
         '--test-name-pattern', pattern],
        cwd=REPO, capture_output=True, text=True, timeout=300)
    p = re.search(r'pass (\d+)', r.stdout)
    f = re.search(r'fail (\d+)', r.stdout)
    return r.returncode, (p.group(1) if p else '?'), (f.group(1) if f else '?')

original = io.open(TARGET, encoding='utf-8').read()

cases = [
    ('FIXED  - silent-command exit code', None, 'REGRESSION: a SILENT verify command'),
    ('BROKEN - silent-command exit code',
     ("    const evidenceBlock = task.verifyCommand", "    const evidenceBlock = verifyOut"),
     'REGRESSION: a SILENT verify command'),
    ('FIXED  - terminal guard', None, 'REGRESSION: a TERMINAL task runs no further cycle'),
    ('BROKEN - terminal guard',
     ("    if (rec.status === 'done' || rec.status === 'exhausted') {", "    if (false) {"),
     'REGRESSION: a TERMINAL task runs no further cycle'),
]

try:
    for label, mut, pattern in cases:
        if mut:
            assert original.count(mut[0]) == 1
            io.open(TARGET, 'w', encoding='utf-8').write(original.replace(mut[0], mut[1]))
        else:
            io.open(TARGET, 'w', encoding='utf-8').write(original)
        code, p, f = run(pattern)
        print(f'{label:42s} exit={code} pass={p} fail={f}')
finally:
    io.open(TARGET, 'w', encoding='utf-8').write(original)
    assert io.open(TARGET, encoding='utf-8').read() == original
    print('\nsource restored byte-identical')