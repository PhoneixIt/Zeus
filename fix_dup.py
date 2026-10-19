with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Replace the duplicate condition - use raw strings to avoid issues
old = """    const canReuse =
      passed !== false &&
      reviewReusable(opts.reviewer.model, rec) &&
      rec.lastEvidenceFingerprint === fp &&
      rec.lastReviewVerdict !== '' &&
      rec.lastReviewVerdict !== 'request-changes' &&
      rec.lastReviewVerdict !== 'request-changes'"""

new = """    const canReuse =
      passed !== false &&
      reviewReusable(opts.reviewer.model, rec) &&
      rec.lastEvidenceFingerprint === fp &&
      rec.lastReviewVerdict !== '' &&
      rec.lastReviewVerdict !== 'request-changes'"""

if old in content:
    content = content.replace(old, new)
    print('Duplicate fixed: removed second \"rec.lastReviewVerdict !== \\'request-changes\\'\"')
else:
    print('Pattern not found, current canReuse section:')
    idx = content.find('const canReuse')
    if idx >= 0:
        print(content[idx:idx+300])

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(content)
print('File written')