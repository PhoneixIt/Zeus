import subprocess, hashlib, io, re

REPO = r'C:\Users\Samer\Projects\AIOS'

# Confirm evidenceFingerprint consumes the EVIDENCE block (incl. exit code), not the review text.
src = io.open(REPO + r'\packages\agent\orchestrator.ts', encoding='utf-8').read()
fp_call = re.search(r'const fp = evidenceFingerprint\(\{[\s\S]*?\}\)', src)
review_fp = re.search(r'const reviewFp = review \? normalizedFindings\(review\.text\) : \'\'', src)
print('=== fingerprint separation ===')
print('evidenceFingerprint call:\n', fp_call.group(0))
print()
print('review fingerprint uses review.text:', bool(review_fp))
print('separate variables fp vs reviewFp:', 'const fp =' in fp_call.group(0) and bool(review_fp))
print()

# Final hashes of the two files I edited
for rel in ['packages/agent/orchestrator.ts', 'packages/agent/test/convergence.test.ts']:
    p = REPO + '\\' + rel.replace('/', '\\')
    h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    n = sum(1 for _ in io.open(p, encoding='utf-8'))
    print(f'{rel}: lines={n} sha256={h}')