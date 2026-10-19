import re, io, os, collections

ROOT = r'C:\Users\Samer\Projects\AIOS\packages'
KINDS = ['file-exists','process-running','process-exited','window-present','window-gone',
         'screen-text-present','screen-text-absent','command-exit-code','http-status','api-response',
         'input-attributed','input-unattributed','directory-present','folder-contents',
         'summary-composed','file-written','file-read-back','file-deleted','command-verified']

# where produced = file that constructs `kind: '<k>'` inside an `evidence` position
produced = collections.defaultdict(set)
for dirpath, _, files in os.walk(ROOT):
    for f in files:
        if not f.endswith('.ts'):
            continue
        p = os.path.join(dirpath, f)
        rel = os.path.relpath(p, ROOT).replace('\\', '/')
        if rel.startswith('test') or '/test/' in rel:
            continue
        try:
            s = io.open(p, encoding='utf-8').read()
        except Exception:
            continue
        for k in KINDS:
            if re.search(r"kind:\s*'" + re.escape(k) + r"'", s):
                produced[k].add(rel)

print('EVIDENCE KIND PRODUCTION (non-test source only)')
print('-' * 70)
for k in KINDS:
    where = sorted(produced.get(k, []))
    if where:
        print('  PRODUCED  %-22s %s' % (k, ', '.join(w.replace('mission-engine/live/', 'live/') for w in where)))
    else:
        print('  NEVER     %-22s (declared in the type, constructed nowhere in production)' % k)

print()
print('counts: produced=%d  never-constructed=%d  (of %d declared)' % (
    sum(1 for k in KINDS if produced.get(k)),
    sum(1 for k in KINDS if not produced.get(k)),
    len(KINDS)))