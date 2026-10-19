import re, io, os

ROOT = r'C:\Users\Samer\Projects\AIOS\packages'
PROJ = r'C:\Users\Samer\Projects\AIOS'

def read(p):
    try:
        return io.open(p, encoding='utf-8').read()
    except Exception:
        return ''

def testfiles():
    for dp, _, fs in os.walk(ROOT):
        if os.sep + 'test' not in dp and not dp.endswith('test'):
            continue
        for f in sorted(fs):
            if f.endswith('.test.ts'):
                yield os.path.join(dp, f)

# Mission completion specifically: X.record.complete, or isComplete(...), or r.complete
PATS = [
    (r'record\.complete\s*===\s*true',   'record.complete === true'),
    (r'record\.complete,\s*true',        'record.complete, true'),
    (r'(?<!basis\.)\bcomplete,\s*true',  'complete, true (non-basis)'),
    (r'isComplete\(',                    'isComplete(...)'),
]

print('=' * 92)
print('STRICT RECOUNT - mission completion only (basis.complete excluded)')
print('=' * 92)

grand = 0
for p in testfiles():
    s = read(p)
    lines = s.split('\n')
    counts = {}
    detail = []
    for i, ln in enumerate(lines):
        for pat, label in PATS:
            for m in re.finditer(pat, ln):
                # skip PlanBasis literal sites: 'complete: true,' inside a basis object
                if re.search(r'basis\s*:\s*\{', ln) and 'usedFacts' in ln:
                    continue
                counts[label] = counts.get(label, 0) + 1
                detail.append((i + 1, ln.strip()[:88]))
    if counts:
        n = sum(counts.values())
        grand += n
        print('\n%s  (%d)' % (os.path.basename(p), n))
        for k, v in sorted(counts.items()):
            print('     %-34s %d' % (k, v))
        for ln_no, txt in detail[:8]:
            print('       :%-5d %s' % (ln_no, txt))
        if len(detail) > 8:
            print('       ... %d more' % (len(detail) - 8))

print('\n' + '=' * 92)
print('TOTAL strict mission-completion assertions in the unit suite: %d' % grand)
