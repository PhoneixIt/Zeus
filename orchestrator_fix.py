import re

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Fix 1: Add rec.lastReviewVerdict !== 'request-changes' to canReuse condition
# Find the canReuse line and modify it
old_canReuse = """    const canReuse =
      passed !== false &&
      reviewReusable(opts.reviewer.model, rec) &&
      rec.lastEvidenceFingerprint === fp &&
      rec.lastReviewVerdict !== ''"""

new_canReuse = """    const canReuse =
      passed !== false &&
      reviewReusable(opts.reviewer.model, rec) &&
      rec.lastEvidenceFingerprint === fp &&
      rec.lastReviewVerdict !== '' &&
      rec.lastReviewVerdict !== 'request-changes'"""

if old_canReuse in content:
    content = content.replace(old_canReuse, new_canReuse)
    print("Fix 1 applied: canReuse condition updated")
else:
    print("Fix 1: old pattern not found, checking current state...")
    # Show what the canReuse line looks like
    idx = content.find('const canReuse')
    if idx >= 0:
        print("Found canReuse at index", idx)
        print(content[idx:idx+200])

# Fix 2: Change verifiedMilestone initialization from 'none' to ''
old_verified = "verifiedMilestone: 'none',"
new_verified = "verifiedMilestone: '',"
if old_verified in content:
    content = content.replace(old_verified, new_verified)
    print("Fix 2 applied: verifiedMilestone changed to empty string")
else:
    print("Fix 2: old pattern not found")

# Fix 3: Remove the early return check I added
# Find the pattern and remove it
old_early_return = """    if (!rec) throw new Error(`task ${task.id} is not in the queue`)
    if (rec.status === 'done' || rec.status === 'exhausted') {
      return { implement: Orchestrator.emptyState('o', 'a', 'r').implement, review: null, record: rec }
    }
    const round = rec.rounds.length"""

new_early_return = """    if (!rec) throw new Error(`task ${task.id} is not in the queue`)
    const round = rec.rounds.length"""

if old_early_return in content:
    content = content.replace(old_early_return, new_early_return)
    print("Fix 3 applied: early return removed")
else:
    print("Fix 3: early return pattern not found (may already be removed or in different form)")

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(content)

print("\nAll fixes applied. File written.")