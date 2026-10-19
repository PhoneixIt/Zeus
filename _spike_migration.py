import re, io, os

ROOT = r'C:\Users\Samer\Projects\AIOS\packages'
LIVE = os.path.join(ROOT, 'mission-engine', 'live')

def read(p):
    try:
        return io.open(p, encoding='utf-8').read()
    except Exception:
        return ''

print('=' * 96)
print('MIGRATION IMPACT - SOURCE-CONFIRMED COUNTS')
print('=' * 96)

# 1. Unit tests asserting completion
print('\n[1] UNIT TESTS asserting record.complete === true')
tot = 0
for dirpath, _, files in os.walk(ROOT):
    if os.sep + 'test' not in dirpath and not dirpath.endswith('test'):
        continue
    for f in sorted(files):
        if not f.endswith('.ts'):
            continue
        p = os.path.join(dirpath, f)
        s = read(p)
        hits = re.findall(r"\.complete,\s*true|\.complete\s*===\s*true|complete:\s*true", s)
        if hits:
            tot += len(hits)
            print('   %-34s %d assertion(s)' % (f, len(hits)))
print('   %-34s %d' % ('TOTAL', tot))

# 2. isComplete direct assertions
print('\n[2] Tests asserting isComplete(...) directly')
tot2 = 0
for dirpath, _, files in os.walk(ROOT):
    if os.sep + 'test' not in dirpath and not dirpath.endswith('test'):
        continue
    for f in sorted(files):
        if not f.endswith('.ts'):
            continue
        s = read(os.path.join(dirpath, f))
        hits = re.findall(r"isComplete\(", s)
        if hits:
            tot2 += len(hits)
            print('   %-34s %d' % (f, len(hits)))
print('   %-34s %d' % ('TOTAL', tot2))

# 3. Live harnesses
print('\n[3] LIVE HARNESSES (files under live/ named run-*)')
harnesses = sorted(f for f in os.listdir(LIVE) if f.startswith('run-') and f.endswith('.ts'))
print('   count: %d' % len(harnesses))
comp = []
for h in harnesses:
    s = read(os.path.join(LIVE, h))
    if re.search(r"\.complete\s*===\s*true|\.complete,\s*true|complete\)\s*===\s*true", s):
        comp.append(h)
print('   of which assert completion === true: %d' % len(comp))
for h in comp:
    print('      - ' + h)

# 4. Plan providers / shapes
print('\n[4] PLAN SHAPES that would need postconditions')
for f in ['deterministic.ts', 'world-aware.ts']:
    s = read(os.path.join(ROOT, 'planner', f))
    n = len(re.findall(r"expectedResult:", s))
    print('   planner/%-20s %d expectedResult site(s)' % (f, n))

# 5. Sites that would consume the verdict
print('\n[5] COMPLETION-REPORTING SITES (must all be gated)')
sites = [
    ('packages/mission-engine/executor.ts', r'complete:\s*isComplete\(m\)'),
    ('packages/mission-engine/supervisor.ts', r'record\.complete'),
    ('packages/persistence/query.ts', r'complete:\s*isComplete\(m\)'),
    ('packages/mission-engine/events.ts', r'complete:\s*boolean'),
    ('packages/mission-engine/state.ts', r'export function isComplete'),
]
for rel, pat in sites:
    s = read(os.path.join(r'C:\Users\Samer\Projects\AIOS', rel.replace('/', os.sep)))
    n = len(re.findall(pat, s))
    print('   %-46s %d match(es)' % (rel, n))
