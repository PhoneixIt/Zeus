import re, io, os

ROOT = r'C:\Users\Samer\Projects\AIOS\packages'

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

# ONE combined pattern, counted per matching LINE (no double counting)
COMBINED = re.compile(r'record\.complete\s*===\s*true|record\.complete\s*,\s*true|isComplete\(|(?<![\w.])complete\s*,\s*true')
BASIS = re.compile(r'usedFacts|PlanBasis')

print('DEDUPLICATED mission-completion assertions (one per line)')
print('-' * 78)
grand = 0
byfile = {}
for p in testfiles():
    s = read(p)
    n = 0
    for ln in s.split('\n'):
        if BASIS.search(ln):          # PlanBasis literal, not mission completion
            continue
        if COMBINED.search(ln):
            n += 1
    if n:
        byfile[os.path.basename(p)] = n
        grand += n
for k in sorted(byfile):
    print('   %-32s %d' % (k, byfile[k]))
print('-' * 78)
print('   %-32s %d' % ('TOTAL', grand))

# The subset that would actually FLIP under a strict fail-closed default:
# assertions expecting TRUE (the ones that would break)
print('\nAssertions expecting TRUE (these break under strict fail-closed):')
tot = 0
for p in testfiles():
    s = read(p)
    n = 0
    for ln in s.split('\n'):
        if BASIS.search(ln):
            continue
        if COMBINED.search(ln) and re.search(r',\s*true\b|===\s*true\b', ln):
            n += 1
    if n:
        tot += n
        print('   %-32s %d' % (os.path.basename(p), n))
print('   %-32s %d' % ('TOTAL BREAKING', tot))
