import io, subprocess

REPO = r'C:\Users\Samer\Projects\AIOS'
TARGET = REPO + r'\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'
X = '\u2716'

def failing(src):
    io.open(TARGET, 'w', encoding='utf-8').write(src)
    r = subprocess.run(
        ['node', '--experimental-strip-types', '--no-warnings', '--test', TEST],
        cwd=REPO, capture_output=True, text=True, timeout=300)
    names = []
    for ln in r.stdout.splitlines():
        s = ln.strip()
        if s.startswith(X + ' '):
            names.append(s[2:].rsplit(' (', 1)[0])
    return names

original = io.open(TARGET, encoding='utf-8').read()
try:
    print('FIXED ->', failing(original) or 'no failures')
    print()
    print('BROKEN evidenceBlock gate ->')
    for n in failing(original.replace(
        "    const evidenceBlock = task.verifyCommand",
        "    const evidenceBlock = verifyOut")):
        print('   ', n)
    print()
    print('BROKEN terminal guard ->')
    for n in failing(original.replace(
        "    if (rec.status === 'done' || rec.status === 'exhausted') {",
        "    if (false) {")):
        print('   ', n)
finally:
    io.open(TARGET, 'w', encoding='utf-8').write(original)
    assert io.open(TARGET, encoding='utf-8').read() == original
    print('\nsource restored byte-identical')