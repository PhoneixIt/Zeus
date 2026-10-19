import re, io, os

ROOT = r'C:\Users\Samer\Projects\AIOS\packages'
KINDS = ['file-exists','process-running','process-exited','window-present','window-gone',
         'screen-text-present','screen-text-absent','command-exit-code','http-status','api-response',
         'input-attributed','input-unattributed','directory-present','folder-contents',
         'summary-composed','file-written','file-read-back','file-deleted','command-verified']

DECL = {'mission-engine/state.ts', 'mission-engine/events.ts', 'planner/plan.ts'}

produced = {}
for k in KINDS:
    where = set()
    for dirpath, _, files in os.walk(ROOT):
        for f in files:
            if not f.endswith('.ts'):
                continue
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, ROOT).replace('\\', '/')
            if rel.startswith('test') or '/test/' in rel or rel in DECL:
                continue
            try:
                s = io.open(p, encoding='utf-8').read()
            except Exception:
                continue
            if re.search(r"kind:\s*'" + re.escape(k) + r"'", s):
                where.add(rel)
    produced[k] = sorted(where)

print('EVIDENCE CONSTRUCTED BY REAL PRODUCERS (tests + type declarations excluded)')
print('=' * 78)
real = miss = 0
for k in KINDS:
    w = produced[k]
    if w:
        real += 1
        print('  YES  %-22s %s' % (k, ', '.join(x.replace('mission-engine/live/', 'live/').replace('mission-engine/', 'me/') for x in w)))
    else:
        miss += 1
        print('  NO   %-22s <-- declared but never constructed outside tests/types' % k)
print()
print('constructed-by-producers: %d    declared-only: %d    total: %d' % (real, miss, len(KINDS)))