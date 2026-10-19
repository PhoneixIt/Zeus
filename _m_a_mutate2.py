import io, subprocess, hashlib

TARGET = r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'
ANCHOR = "    } else if (roundCount >= task.maxReviewRounds) {"

original = io.open(TARGET, encoding='utf-8').read()
orig_hash = hashlib.sha256(original.encode()).hexdigest()[:16]
assert original.count(ANCHOR) == 1

def run(label):
    r = subprocess.run(
        ['node', '--experimental-strip-types', '--no-warnings', '--test', TEST],
        cwd=r'C:\Users\Samer\Projects\AIOS', capture_output=True, text=True, timeout=300)
    out = r.stdout
    i = out.find('failing tests:')
    tail = out[i:] if i >= 0 else ''
    print('--- %s : exit=%d ---' % (label, r.returncode))
    if not tail:
        print('    (no failures)')
    for ln in tail.splitlines():
        s = ln.strip()
        if s.startswith('\u2716') or s.startswith('AssertionError'):
            print('   ', s)
    print()

try:
    run('FIXED')
    io.open(TARGET, 'w', encoding='utf-8').write(
        original.replace(ANCHOR, "    } else if (false && roundCount >= task.maxReviewRounds) {"))
    run('BUDGET BRANCH DISABLED')
    io.open(TARGET, 'w', encoding='utf-8').write(
        original.replace(ANCHOR, "    } else if (roundCount > task.maxReviewRounds) {"))
    run('BUDGET OFF-BY-ONE  (> instead of >=)')
finally:
    io.open(TARGET, 'w', encoding='utf-8').write(original)
    assert io.open(TARGET, encoding='utf-8').read() == original
    print('source restored byte-identical:', hashlib.sha256(
        io.open(TARGET, encoding='utf-8').read().encode()).hexdigest()[:16], '==', orig_hash)