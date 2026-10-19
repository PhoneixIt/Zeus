import io, subprocess

REPO = r'C:\Users\Samer\Projects\AIOS'
TARGET = REPO + r'\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'

def failing_names(src):
    io.open(TARGET, 'w', encoding='utf-8').write(src)
    r = subprocess.run(
        ['node', '--experimental-strip-types', '--no-warnings', '--test', TEST],
        cwd=REPO, capture_output=True, text=True, timeout=300)
    return [ln.strip() for ln in r.stdout.splitlines() if ln.startswith('\u2716 ')]

original = io.open(TARGET, encoding='utf-8').read()

try:
    print('=== FIXED source: failing tests ===')
    print(failing_names(original) or 'none')

    print()
    print('=== BROKEN evidenceBlock gate ===')
    for n in failing_names(original.replace(
        "    const evidenceBlock = task.verifyCommand",
        "    const evidenceBlock = verifyOut")):
        print(' ', n)

    print()
    print('=== BROKEN terminal guard ===')
    for n in failing_names(original.replace(
        "    if (rec.status === 'done' || rec.status === 'exhausted') {",
        "    if (false) {")):
        print(' ', n)
finally:
    io.open(TARGET, 'w', encoding='utf-8').write(original)
    assert io.open(TARGET, encoding='utf-8').read() == original
    print('\nsource restored byte-identical')