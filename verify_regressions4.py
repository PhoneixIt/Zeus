import io, subprocess, re

REPO = r'C:\Users\Samer\Projects\AIOS'
TARGET = REPO + r'\packages\agent\orchestrator.ts'
TEST = r'packages/agent/test/convergence.test.ts'

def summary(src):
    io.open(TARGET, 'w', encoding='utf-8').write(src)
    r = subprocess.run(
        ['node', '--experimental-strip-types', '--no-warnings', '--test', TEST],
        cwd=REPO, capture_output=True, text=True, timeout=300)
    out = r.stdout
    names = re.findall(r'^\u2716 (.+?) \(\d', out, re.M)
    p = re.search(r'pass (\d+)', out); f = re.search(r'fail (\d+)', out)
    return r.returncode, p.group(1) if p else '?', f.group(1) if f else '?', names

original = io.open(TARGET, encoding='utf-8').read()
try:
    for label, src in [
        ('FIXED', original),
        ('BROKEN evidenceBlock gate', original.replace(
            "    const evidenceBlock = task.verifyCommand",
            "    const evidenceBlock = verifyOut")),
        ('BROKEN terminal guard', original.replace(
            "    if (rec.status === 'done' || rec.status === 'exhausted') {",
            "    if (false) {")),
    ]:
        code, p, f, names = summary(src)
        print(f'--- {label}: exit={code} pass={p} fail={f}')
        for n in names:
            print('     fails:', n)
finally:
    io.open(TARGET, 'w', encoding='utf-8').write(original)
    assert io.open(TARGET, encoding='utf-8').read() == original
    print('\nsource restored byte-identical')