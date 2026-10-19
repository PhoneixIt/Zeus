#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Status determination is around lines 511-546 (1-indexed), 510-545 (0-indexed)
# I need to swap the repeastKnownFound block with the roundBudget block

# Key line numbers (0-based):
# Line 511 (0-based 510): if (outcome === 'approved') {
# Line 512 (0-based 511): rec.status = 'done';
# Line 513 (0-based 512): } else if (repeatsKnownFound) {
# Lines 514-522 (0-based 513-522): repeastKnownFound body
# Line 523 (0-based 522): } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
# Lines 524-536 (0-based 523-536): OUTCOME_IS_THE_INFORMATION body
# Line 537 (0-based 537): } else if (roundCount >= task.maxReviewRounds) {
# Lines 538-540 (0-based 537-540): roundBudget body
# Line 541 (0-based 541): } else if (outcome === 'reviewer-unavailable') {
# Line 542 (0-based 542): unavailable body
# Line 543 (0-based 542): } else {
# Line 544 (0-based 543): rec.status = 'pending';

# New desired order (0-based line indices):
# 1. if (outcome === 'approved') { ... }          - lines 510-512, stays
# 2. } else if (roundCount >= task.maxReviewRounds) { ... }  - MOVED from 538 to after approved
# 3. } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) { ... }  - stays at 523-536
# 4. } else if (repeatsKnownFound) { ... }  - MOVED DOWN from 513 to after OUTCOME
# 5. } else if (outcome === 'reviewer-unavailable') { ... }  - stays
# 6. } else { ... }  - stays

# Let me extract each block as (start_idx, end_idx, content_string)
# I need to find the exact line ranges

# Find the approved if block - it starts at line 511 (1-indexed) = 510 (0-based)
# and includes the if keyword and its body until the closing }

# Actually, let me just identify the exact line ranges by looking at the lines

# repeastKnownFound block: starts at line 514 (1-indexed) = 513 (0-based)
#    line 514: } else if (repeatsKnownFound) {
#    lines 515-523: rec.status = 'exhausted'; ... this.state.blockers.push
#    end of block: just before the next } else if

# roundBudget block: starts at line 538 (1-indexed) = 537 (0-based)
#    line 538: } else if (roundCount >= task.maxReviewRounds) {
#    lines 539-541: rec.status = 'exhausted'; rec.note = review budget; blockers push
#    end of block: just before } else if (outcome === 'reviewer-unavailable')

# OUTCOME_IS_THE_INFORMATION block: lines 524-536 (0-based 523-536)
#    line 524: } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
#    lines 525-536: block body

# Let me find the exact end of each block by searching for the next '} else if' pattern

# For repeastKnownFound block: ends just before the OUTCOME_IS_THE_INFORMATION block
outcome_marker = '} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {'
outcome_idx = None
for i, line in enumerate(lines):
    if outcome_marker in line:
        outcome_idx = i
        break
print('OUTCOME_IS_THE_INFORMATION at 0-based index:', outcome_idx)

# For roundBudget block: ends just before reviewer-unavailable check
reviewer_marker = '} else if (outcome === "reviewer-unavailable")'
reviewer_idx = None
for i in range(outcome_idx, len(lines)) if outcome_idx else range(outcome_idx or 0, len(lines)):
    if reviewer_marker in lines[i]:
        reviewer_idx = i
        break
if reviewer_idx:
    print('reviewer-unavailable at 0-based index:', reviewer_idx)
else:
    reviewer_idx = len(lines)
    print('reviewer-unavailable not found, using end')

# Now I can define the block boundaries:
# repeastKnownFound block: from its start to outcome_idx (exclusive)
# roundBudget block: from idx_budget to reviewer_idx (exclusive)
# OUTCOME_IS_THE_INFORMATION block: from outcome_idx to reviewer_idx (exclusive)

# But I need the repeastKnownFound start position
repeats_marker = '} else if (repeatsKnownFound) {'
repeats_start = None
for i, line in enumerate(lines):
    if repeats_marker in line:
        repeats_start = i
        break
print('repeastKnownFound at 0-based index:', repeats_start)

# Now I have:
# repeast_start = some index < outcome_idx
# budget_start = some index > outcome_idx
# outcome_start = outcome_idx
# reviewer_end = reviewer_idx

# New order should be:
# approved -> roundBudget -> OUTCOME -> repeast -> unavailable -> else

# Let me extract the content blocks:
# 1. The approved block (from the approved if to just before repeastKnownFound)
# 2. The roundBudget block (from budget_start to reviewer_idx)
# 3. The OUTCOME_IS_THE_INFORMATION block (from outcome_idx to reviewer_idx)
# 4. The repeastKnownFound block (from repeats_start to outcome_idx)
# 5. The reviewer-unavailable block (from reviewer_idx to the else block)
# 5. The else block

# This is getting extremely complex. Let me try a completely different approach.

# What if I just modify the condition of the repeastKnownFound check to also 
# check the round count? No, that weakens the safety purpose.

# What if I just modify the normalizedFindings function to preserve the round number?
# Let me check if that's feasible without breaking other things.

# Actually, the simplest fix might be to just change the test expectations.
# But the user said "Do not weaken tests or alter expected values unless the existing assertion 
# is demonstrably incorrect and the correction is independently justified."

# Let me check: is the test expectation demonstrably incorrect? 
# The test says "it must stop at the review budget, not keep going" with 3 rounds expected.
# The current behavior gives 2 rounds because of fingerprint collision.
# The fingerprint collision is an artifact of the normalization, not a true "repeated finding."
# So the test expectation IS correct, and the code has a bug.

# The bug is that normalizedFindings strips too much information, causing false fingerprint collisions.
# Fixing the normalizer would be the most correct fix, but it might have wide-ranging effects.

# Let me try the simplest fix: reorder the if-else checks so budget comes before repeastKnownFound.
# I'll do this by rewriting the status determination section.

# Let me find the exact text I need to swap
# Read the file and locate the specific sections
output = []
for i in range(510, 545):
    if i < len(lines):
        output.append(f'Line {i+1}: {lines[i].rstrip()}')
for line in output:
    print(line)