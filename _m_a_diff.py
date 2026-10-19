import io, hashlib, difflib, os

REPO = r'C:\Users\Samer\Projects\AIOS'
TEST = REPO + r'\packages\agent\test\convergence.test.ts'
BAK = os.environ['TEMP'] + r'\convergence.pre-ma.bak'
ORCH = REPO + r'\packages\agent\orchestrator.ts'

new = io.open(TEST, encoding='utf-8').read().splitlines()
old = io.open(BAK, encoding='utf-8').read().splitlines()

print('=== convergence.test.ts: M-a diff ===')
added = removed = 0
for ln in difflib.unified_diff(old, new, lineterm='', n=0):
    if ln.startswith('+++') or ln.startswith('---') or ln.startswith('@@'):
        continue
    if ln.startswith('+'):
        added += 1
    elif ln.startswith('-'):
        removed += 1
        print('  REMOVED:', ln)
print(f'  lines added: {added}   lines removed: {removed}')
print(f'  file lines : {len(old)} -> {len(new)}')

print()
print('=== production code untouched ===')
h = hashlib.sha256(io.open(ORCH, 'rb').read()).hexdigest()
print('  orchestrator.ts sha256:', h[:16], '(expected 35fa0a2e3702e18b)')
print('  MATCH:', h[:16] == '35fa0a2e3702e18b')