import io, subprocess, hashlib

TARGET = r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'

original = io.open(TARGET, encoding='utf-8').read()
orig_hash = hashlib.sha256(original.encode()).hexdigest()[:16]

# The budget branch, exactly as it reads now.
ANCHOR = "    } else if (roundCount >= task.maxReviewRounds) {"
assert original.count(ANCHOR) == 1, original.count(ANCHOR)

def run(label):
    r = subprocess.run(
        ['node', '--experimental-strip-types', '--no-warnings', '--test', TEST],
        cwd=r'C:\Users\Samer\Projects\AIOS', capture_output=True, text=True, timeout=300)
    names = [ln.strip() for ln in r.stdout.splitlines() if ln.strip().startswith('\u2716 ')]
    print(f'{label}: exit={r.returncode}')
    for n in names:
        print('   FAILS:', n[2:].rsplit(' (', 1)[0])
    return r.returncode

try:
    print('=== BASELINE (unmutated) ===')
    run('  fixed source')

    print()
    print('=== MUTATION: budget branch disabled ===')
    # Replace the condition with one that can never be true, leaving the branch present but dead.
    io.open(TARGET, 'w', encoding='utf-8').write(
        original.replace(ANCHOR, "    } else if (false && roundCount >= task.maxReviewRounds) {"))
    run('  broken source')

    print()
    print('=== MUTATION: budget off-by-one (>= becomes >) ===')
    io.open(TARGET, 'w', encoding='utf-8').write(
        original.replace(ANCHOR, "    } else if (roundCount > task.maxReviewRounds) {"))
    run('  off-by-one source')
finally:
    io.open(TARGET, 'w', encoding='utf-8').write(original)
    back = io.open(TARGET, encoding='utf-8').read()
    assert back == original, 'RESTORE FAILED'
    print()
    print('source restored byte-identical:', hashlib.sha256(back.encode()).hexdigest()[:16], '==', orig_hash)