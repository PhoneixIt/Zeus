#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Status determination is around lines 511-545 (1-indexed), 510-544 (0-indexed)
# Current order of if-else blocks:
# 514: } else if (repeatsKnownFound) {
# 524: } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
# 538: } else if (roundCount >= task.maxReviewRounds) {
# 542: } else if (outcome === 'reviewer-unavailable') {
# 544: } else {

# New desired order:
# 1. } else if (roundCount >= task.maxReviewRounds) {  - MOVED UP from 538
#    514: } else if (repeatsKnownFound) {  - MOVED DOWN after OUTCOME block
#    524: } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {  - stays
#    542: } else if (outcome === 'reviewer-unavailable) {  - stays
#    544: } else {  - stays

# Let me extract each block's content by line indices (0-based)
# Line 514 (1-indexed) = 513 (0-indexed): } else if (repeatsKnownFound) {
# Line 524 (1-indexed) = 523 (0-indexed): } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
# Line 538 (1-indexed) = 537 (0-indexed): } else if (roundCount >= task.maxReviewRounds) {
# Line 542 (1-indexed) = 541 (0-indexed): } else if (outcome === 'reviewer-unavailable') {
# Line 544 (1-indexed) = 543 (0-indexed): } else {

# The repeastKnownFound block content (lines 515-523 in 1-indexed = indices 514-522 in 0-indexed)
repeats_block_lines = lines[514:523]  # indices 514-522 inclusive
repeats_block = ''.join(repeats_block_lines)
print('repeats block:', repr(repeats_block[:100]))

# The OUTCOME block (lines 525-536 in 1-indexed = indices 524-535 in 0-indexed)
outcome_block_lines = lines[524:536]  # indices 524-535 inclusive
outcome_block = ''.join(outcome_block_lines)
print('outcome block:', repr(outcome_block[:100]))

# The roundBudget block (lines 539-541 in 1-indexed = indices 538-540 in 0-indexed)
budget_block_lines = lines[538:541]  # indices 538-540 inclusive
budget_block = ''.join(budget_block_lines)
print('budget block:', repr(budget_block[:100]))

# The reviewer-unavailable block (lines 543-543 in 1-indexed = index 542 in 0-indexed... wait)
# Line 542 (1-indexed) = 541 (0-indexed): } else if (outcome === 'reviewer-unavailable') {
# Line 543 (1-indexed) = 542 (0-indexed): unavailable body
# Line 544 (1-indexed) = 543 (0-indexed): } else {

# Let me get the unavailable block
unavailable_block_lines = lines[542:544]  # indices 542-543 inclusive
unavailable_block = ''.join(unavailable_block_lines)
print('unavailable block:', repr(unavailable_block[:100]))

# The else block (line 545 in 1-indexed = index 544 in 0-indexed)
else_block = lines[544]
print('else block:', repr(else_block))

# The approved if block (lines 511-513 in 1-indexed = indices 510-512 in 0-indexed)
approved_if_lines = lines[510:513]  # indices 510-512 inclusive
approved_if = ''.join(approved_if_lines)
print('approved if block:', repr(approved_if[:100]))

# Now reconstruct with new order:
# New order: approved if -> roundBudget -> OUTCOME -> repeastKnownFound -> reviewer-unavailable -> else

# Part 1: approved if block (keeps in place)
part1 = ''.join(lines[510:514])  # indices 510-512 + line 513? 
# Actually, the approved if starts at line 511 (1-indexed) = index 510
# and includes lines 511-513 (the if keyword, status setting, and passed check)
# But the if-else chain starts at line 514

# Let me just identify what's between the approved if and the first else-if
# The approved if is: if (outcome === 'approved') { ... }
# And its body ends before the } else if (repeatsKnownFound) {

# Let me find the exact structure
# Line 511: if (outcome === 'approved') {
# Line 512: rec.status = 'done';
# Line 513: if (passed) this.state.verifiedMilestone = ...
# Line 514: } else if (repeatsKnownFound) {

# So the approved if block is lines 511-513 (3 lines), and the if-else chain starts at line 514

# New order reconstruction:
# Part 1: lines 510-513 (approved if and status setting) - KEPT IN PLACE
# Part 2: roundBudget block (lines 538-541, moved UP)
# Part 2.5: the line that was between approved and the if-else chain? No, the if-else chain starts at 514

# Hmm, I need to be more careful. Let me identify the exact content to move.

# The roundBudget block is at lines 538-541 (1-indexed) = indices 537-540 (0-indexed)
# The repeastKnownFound block starts at line 514 (1-indexed) = index 513 (0-indexed)

# New order wants:
# - roundBudget block moved to AFTER the approved if block (after line 513)
# - repeastKnownFound block moved to AFTER the OUTCOME block (after line 536)

# Let me extract the roundBudget block content
budget_block = ''.join(lines[537:541])  # indices 537-540 (0-indexed), which is lines 538-541 (1-indexed)
print('roundBudget block content:', repr(budget_block[:100]))

# The repeastKnownFound block content (lines 515-523 in 1-indexed = indices 514-522 0-indexed)
repeast_block = ''.join(lines[514:523])  # indices 514-522 (0-indexed), which is lines 515-523 (1-indexed)
print('repeastKnownFound block content:', repr(repeast_block[:100]))

# The OUTCOME block (lines 525-536 in 1-indexed = indices 524-535 0-indexed)
outcome_block = ''.join(lines[524:536])  # indices 524-535 (0-indexed), which is lines 525-536 (1-indexed)
print('OUTCOME block content:', repr(outcome_block[:100]))

# The reviewer-unavailable block (lines 543-543 in 1-indexed... let me check)
# Line 542 (1-indexed): } else if (outcome === 'reviewer-unavailable') {
# Line 543 (1-indexed): unavailable body
# Line 544 (1-indexed): } else {
# Line 545 (1-indexed): rec.status = 'pending'

# Let me get the unavailable body and else block
unavailable_body = lines[542]  # line 542 (1-indexed): the } else if condition
unavailable_body_content = lines[543]  # line 543: the body
else_line = lines[544]  # line 544: } else {
pending_line = lines[545]  # line 545: rec.status = 'pending'

print('unavailable body:', repr(unavailable_body))
print('unavailable content:', repr(unavailable_body_content))
print('else line:', repr(else_line))
print('pending line:', repr(pending_line))

# Now reconstruct the new status determination section:
# The full section goes from line 511 (index 510) to line 545 (index 544)
# Current order of if-else blocks within this section:
# 1. if (outcome === 'approved') { ... }  - lines 511-513
# 2. } else if (repeatsKnownFound) { ... }  - lines 514-523
# 3. } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) { ... }  - lines 525-536? Wait...

# Actually, let me re-examine. The status determination if-else chain starts at line 514:
# 514: } else if (repeatsKnownFound) {
# 515-522: body
# 524: } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
# 525-536: body
# 538: } else if (roundCount >= task.maxReviewRounds) {
# 539-541: body
# 542: } else if (outcome === 'reviewer-unavailable') {
# 543: body
# 544: } else {
# 545: rec.status = 'pending'

# New order:
# 1. } else if (roundCount >= task.maxReviewRounds) {  - MOVED from 538 to after approved
#    But wait, this needs to be after the approved if block closes

# Let me think about this differently. The if-else chain in the status determination is:
# After the approved check and its body, we have:
# } else if (repeatsKnownFound) {  ...  }
# } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {  ...  }
# } else if (roundCount >= task.maxReviewRounds) {  ...  }
# } else if (outcome === 'reviewer-unavailable') {  ...  }
# } else {  ...  }

# New order should be:
# } else if (roundCount >= task.maxReviewRounds) {  ...  }  <- MOVED UP
# } else if (repeatsKnownFound) {  ...  }  <- MOVED DOWN
# } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {  ...  }  <- stays
# } else if (outcome === 'reviewer-unavailable') {  ...  }  <- stays
# } else {  ...  }  <- stays

# So I need to:
# 1. Move the roundBudget block (lines 538-541) to be right after the approved if block closes (after line 513)
# 2. Move the repeastKnownFound block (lines 514-523) to be after the OUTCOME block (after line 536)

# For step 1: I need to insert the roundBudget block between line 513 and line 514
# For step 2: I need to move the repeast block to after line 536

# Let me do this by manipulating the lines list:

# First, remove the roundBudget block from its current position (lines 538-541)
budget_block_content = ''.join(lines[537:541])  # 0-indexed 537-540 = lines 538-541
print('Removed budget block:', repr(budget_block[:100]))

# Remove it from the lines list
del lines[537:541]

# Now insert the budget block after line 513 (which is the `if (passed)` line, the last line of the approved if block)
# Line 513 (1-indexed) = index 512 (0-indexed) is the last line of the approved if block
# I want to insert after line 513, so at index 513 (which will push the old line 514 down)
lines.insert(513, budget_block)  # This inserts at position 513, pushing old line 514 (now old 513) to 515

print('\\nAfter inserting budget block:')
for i in range(510, 520):
    if i < len(lines):
        print(f'Line {i+1}: {lines[i].rstrip()[:80]}')

# Now I need to move the repeastKnownFound block to after the OUTCOME block
# The OUTCOME block is at lines 525-536 (1-indexed)... but the line numbers have shifted due to the insertion
# Let me find the current position of the repeastKnownFound block

# The repeastKnownFound marker was originally at line 514 (1-indexed), but has shifted due to the insertion
# Let me search for it
repeats_marker = '} else if (repeatsKnownFound) {'
repeats_idx = None
for i, line in enumerate(lines):
    if repeats_marker in line:
        repeats_idx = i
        break
print('\\nrepeast marker at 0-based index:', repeats_idx)

if repeats_idx is not None:
    # Find the OUTCOME marker
    outcome_marker = '} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {'
    outcome_idx = None
    for i in range(repeats_idx, len(lines)):
        if outcome_marker in lines[i]:
            outcome_idx = i
            break
    
    if outcome_idx is not None:
        # Remove the repeast block from its current position
        # The repeast block includes the marker line and its body
        # Find the end of the repeast block (before the OUTCOME marker)
        # Actually, the repeast block goes from its marker to just before the OUTCOME marker
        # But I need to know the body lines too
        
        # Get the repeast block content from its marker to just before the OUTCOME marker
        repeast_block_content = ''.join(lines[repeats_idx:outcome_idx]) if outcome_idx else ''.join(lines[repeats_idx:])
        print('repeast block content length:', len(repeast_block_content))
        
        # Now insert the repeast block after the OUTCOME block
        # Find the OUTCOME block's end position
        # The OUTCOME block ends just before the reviewer-unavailable marker
        reviewer_marker = '} else if (outcome === "reviewer-unavailable")'
        reviewer_idx = None
        for i in range(outcome_idx, len(lines)):
            if reviewer_marker in lines[i]:
                reviewer_idx = i
                break
        
        if reviewer_idx is not None:
            # Insert the repeast block after the OUTCOME block (before the reviewer marker)
            lines.insert(reviewer_idx, repeast_block_content)
            print('\\nInserted repeast block after OUTCOME block')
            
            print('\\nFinal status determination lines:')
            for i in range(510, min(550, len(lines))):
                print(f'Line {i+1}: {lines[i].rstrip()[:80]}')