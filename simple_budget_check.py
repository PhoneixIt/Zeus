#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Identify the exact lines for the two blocks we need to swap
# Line 514 (index 513): } else if (repeatsKnownFound) {
# Lines 515-523: block body (status = exhausted, blockers push)
# Line 524 (index 523): } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
# Lines 525-536: block body
# Line 538 (index 537): } else if (roundCount >= task.maxReviewRounds) {
# Lines 539-541: block body (status = exhausted, note = review budget)
# Line 542 (index 541): } else if (outcome === 'reviewer-unavailable') {
# Line 543 (index 542): block body
# Line 544 (index 543): } else {

# I need to swap the repeastKnownFound block (lines 514-523) with the roundBudget block (lines 538-541)

# But the blocks have different numbers of lines, and there's the OUTCOME_IS_THE_INFORMATION block between them (lines 524-536).

# Let me think about this differently. I'll just rewrite the entire status determination section
# with the new order: approved -> roundBudget -> OUTCOME_IS_THE_INFORMATION -> repeastKnownFound -> reviewer-unavailable -> else

# First, let me identify all the relevant line ranges (0-based indices)
status_start = None
status_end = None

for i, line in enumerate(lines):
    if 'if (outcome === .approved.)' in line or "if (outcome === 'approved')" in line:
        status_start = i
    if '} else {' in line and i > 540:
        status_end = i
        break

if status_start is None:
    print('Could not find status start')
    # Try alternative
    for i, line in enumerate(lines):
        if 'rec.status = .done.' in line:
            status_start = i
            break

if status_start is None:
    print('Cannot find status section')
    # Just work with known line numbers
    # The status determination is around lines 511-546 (1-indexed)
    # Let me use those
    status_start = 500  # approximate
    
print('status_start:', status_start)

# Let me just work with the known line numbers from the file
# Lines 511-546 (1-indexed) contain the status determination
# 0-based: lines 510-545

# Let me identify the exact content of each block by line number
# Line 511 (0-based 510): if (outcome === 'approved') {
# Line 512 (0-based 511): rec.status = 'done';
# Line 513 (0-based 512): } else if (repeatsKnownFound) {
# Line 514-522 (0-based 513-522): block body
# Line 523 (0-based 522): } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
# Line 524-536 (0-based 523-536): block body
# Line 538 (0-based 537): } else if (roundCount >= task.maxReviewRounds) {
# Line 539-541 (0-based 538-540): block body
# Line 542 (0-based 541): } else if (outcome === 'reviewer-unavailable') {
# Line 543 (0-based 542): block body
# Line 544 (0-based 543): } else {
# Line 545 (0-based 544): rec.status = 'pending';

# New desired order:
# 1. if (outcome === 'approved') { ... }  - stays
# 2. } else if (roundCount >= task.maxReviewRounds) { ... }  - MOVED UP from position 538
# 3. } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) { ... }  - stays
# 4. } else if (repeatsKnownFound) { ... }  - MOVED DOWN from position 514
# 5. } else if (outcome === 'reviewer-unavailable') { ... }  - stays
# 6. } else { ... }  - stays

# So I need to:
# - Move the roundBudget block (lines 538-541) to after the approved check
# - Move the repeastKnownFound block (lines 513-522) to after the OUTCOME_IS_THE_INFORMATION block
# - Shift everything accordingly

# Let me extract each block's content
def get_block(start_idx, end_idx, lines):
    """Get lines from start_idx to end_idx (inclusive), return as single string"""
    return ''.join(lines[start_idx:end_idx+1])

# Get the approved block (stays in place)
approved_block = ''.join(lines[status_start:status_start+5]) if status_start else ''

# Get the repeastKnownFound block (lines 513-522, 0-based)
repeats_block_start = 512  # 0-based index for line 514
repeats_block_end = 523  # 0-based index for line 523 (inclusive)
repeats_block = ''.join(lines[repeats_block_start:repeats_block_end+1])
print('repeats_block:', repr(repeats_block[:100]))

# Get the OUTCOME_IS_THE_INFORMATION block (lines 523-536, 0-based)
outcome_block_start = 523  # 0-based index for line 524
outcome_block_end = 536  # 0-based index for line 536 (inclusive)
outcome_block = ''.join(lines[outcome_block_start:outcome_block_end+1])
print('outcome_block:', repr(outcome_block[:100]))

# Get the roundBudget block (lines 538-541, 0-based)
budget_block_start = 537  # 0-based index for line 538
budget_block_end = 541  # 0-based index for line 541 (inclusive)
budget_block = ''.join(lines[budget_block_start:budget_block_end+1])
print('budget_block:', repr(budget_block[:100]))

# Get the reviewer-unavailable block (lines 542-543, 0-based)
unavailable_block_start = 542  # 0-based index for line 542
unavailable_block_end = 543  # 0-based index for line 543 (inclusive)
unavailable_block = ''.join(lines[unavailable_block_start:unavailable_block_end+1])
print('unavailable_block:', repr(unavailable_block[:100]))

# Get the else block (line 544-545, 0-based)
else_block_start = 544  # 0-based index for line 544
else_block_end = 544  # 0-based index for line 544 (just one line)
else_block = ''.join(lines[else_block_start:else_block_end+1])
print('else_block:', repr(else_block))

# Now reconstruct with new order:
# New order: approved -> budget -> OUTCOME -> repeast -> unavailable -> else
new_lines = []

# 1. Approved block (from status_start to just before repeastKnownFound)
# The approved block goes from status_start to just before line 513 (repeastKnownFound)
# Find where the approved block ends (the } that closes the if)
# Actually, let me find the structure better

# Let me find the 'if (outcome === .approved.)' line and its closing
for i in range(status_start, min(status_start+10, len(lines))):
    print(f'Line {i+1}: {lines[i].rstrip()[:80]}')

# I need a different approach. Let me just rebuild the entire status determination section
# by extracting the right pieces and reassembling.

# Let me find the exact boundaries
# Find 'if (outcome === .approved.)' 
idx_approved_if = None
for i, line in enumerate(lines):
    if "if (outcome === 'approved')" in line:
        idx_approved_if = i
        break

print('approved if at index:', idx_approved_if)

# Find the closing brace of the approved if block
# It should be followed by the if-else chain
for i in range(idx_approved_if+1, min(idx_approved_if+10, len(lines))):
    if 'rec.status = .done.' in lines[i]:
        print('approved status set at line', i+1)
        break

# Let me take a completely different approach: just modify the condition check
# Instead of reordering the if-else chain, I'll modify the repeastKnownFound 
# check to also consider the round count, or I'll modify the normalizer.

# Actually, the simplest fix: just change the repeastKnownFound condition to also 
# check that we haven't exceeded the budget. But that weakens the safety purpose.

# OR: I can just add a check at the beginning of the status determination that returns
# exhausted if the round count exceeds the budget, BEFORE the repeastKnownFound check.

# Let me try this: insert a budget check right after the outcome determination and review processing,
# but before the if-else chain for status.

# Find a good insertion point: after line 510 (const roundCount) and before line 511 (if outcome)
idx_insert = 510  # 0-based, after the roundCount line

# The content to insert: a budget check
budget_check = '''
    if (roundCount >= task.maxReviewRounds) {
      rec.status = 'exhausted'; rec.finishedAt = nowIso()
      rec.note = `review budget of ${task.maxReviewRounds} rounds spent without approval`
      this.state.blockers.push(\`\${task.id}: \${rec.note}\`)
    } else '''

# Insert the budget check
insert_pos = idx_insert + len('const roundCount = rec.rounds.filter((r) => r.role === \'reviewer\').length\n')
new_content = content[:insert_pos] + budget_check + content[insert_pos:]

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(new_content)
print('Budget check inserted')