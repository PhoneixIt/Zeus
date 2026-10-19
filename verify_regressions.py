"""Verify each regression test actually fails when its fix is reverted.

Each mutation is applied to the real file, the targeted test is run, and the file is
restored from the pre-mutation snapshot in a finally block.
"""
import hashlib
import io
import subprocess
import sys

REPO = r'C:\Users\Samer\Projects\AIOS'
TARGET = REPO + r'\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'


def run(name_filter):
    cmd = ['node', '--experimental-strip-types', '--no-warnings', '--test',
           TEST, '--test-name-pattern', name_filter]
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=300)
    return r.returncode, r.stdout


def mutate(src, old, new):
    assert src.count(old) == 1, ('anchor count', src.count(old))
    return src.replace(old, new)


MUTATIONS = [
    (
        'revert evidenceBlock gate: verifyOut instead of task.verifyCommand',
        """    const evidenceBlock = task.verifyCommand""",
        """    const evidenceBlock = verifyOut""",
        'REGRESSION: a SILENT verify command',
    ),
    (
        'revert terminal guard: remove it entirely',
        """    if (rec.status === 'done' || rec.status === 'exhausted') {""",
        """    if (false) {""",
        'REGRESSION: a TERMINAL task runs no further cycle',
    ),
]

original = io.open(TARGET, encoding='utf-8').read()
print('baseline sha256:', hashlib.sha256(original.encode()).hexdigest()[:16])

for label, old, new, pattern in MUTATIONS:
    print()
    print('=' * 70)
    print('MUTATION:', label)
    try:
        io.open(TARGET, 'w', encoding='utf-8').write(mutate(original, old, new))
        code, out = run(pattern)
        fails = 'fail 0' not in out
        summary = [ln for ln in out.splitlines() if ln.startswith(('\u2139 pass', '\u2139 fail'))]
        print('exit code:', code)
        print('summary:', ' | '.join(summary))
        print('REGRESSION TEST DETECTED THE REGRESSION:', fails)
    finally:
        io.open(TARGET, 'w', encoding='utf-8').write(original)
        restored = io.open(TARGET, encoding='utf-8').read()
        assert restored == original, 'RESTORE FAILED'
        print('restored OK')

print()
print('final sha256:', hashlib.sha256(io.open(TARGET, encoding='utf-8').read().encode()).hexdigest()[:16])