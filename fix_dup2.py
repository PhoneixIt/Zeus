with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Replace the duplicate condition
old = """rec.lastReviewVerdict !== '' &&
      rec.lastReviewVerdict !== 'request-changes' &&
      rec.lastReviewVerdict !== 'request-changes'"""

new = """rec.lastReviewVerdict !== '' &&
      rec.lastReviewVerdict !== 'request-changes'"""

if old in content:
    content = content.replace(old, new)
    print('Duplicate fixed')
else:
    print('Pattern not found')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(content)
print('Done')