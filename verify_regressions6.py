import io, subprocess

REPO = r'C:\Users\Samer\Projects\AIOS'
TARGET = REPO + r'\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'

original = io.open(TARGET, encoding='utf-8').read()

def tail(src):
    io.open(TARGET, 'w', encoding='utf-8').write(src)
    r = subprocess.run(
        ['node', '--experimental-strip-types', '--no-warnings', '--test', TEST],
        cwd=REPO, capture_output=True, text=True, timeout=300)
    i = r.stdout.find('failing tests:')
    return r.stdout[i:i + 900] if i >= 0 else '(no failing section)'

try:
    print('##### BROKEN evidenceBlock gate #####')
    print(tail(original.replace(
        "    const evidenceBlock = task.verifyCommand",
        "    const evidenceBlock = verifyOut")))
finally:
    io.open(TARGET, 'w', encoding='utf-8').write(original)
    assert io.open(TARGET, encoding='utf-8').read() == original
    print('source restored byte-identical')