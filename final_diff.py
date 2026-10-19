import difflib

cur = open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', encoding='utf-8').read().splitlines()
pre = open(r'C:\Users\Samer\Projects\AIOS\orchestrator_ts_pre_repair_1791683044.ts', encoding='utf-8').read().splitlines()

print('=== orchestrator.ts: my edits relative to the repaired baseline ===')
d = list(difflib.unified_diff(pre, cur, fromfile='pre-repair', tofile='final', lineterm='', n=1))
# Only show added/removed content lines plus hunk headers
for ln in d:
    if ln.startswith(('+++', '---', '@@')):
        continue
    if ln.startswith(('+', '-')):
        print(ln)