#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Status determination lines (0-based indices 510-545, corresponding to 1-indexed 511-546)
# Current order:
# 513: } else if (repeatsKnownFound) {
# 514-522: repeastKnownFound body (status=exhausted, blockers with "repeating findings")
# 524: } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {
# 525-536: OUTCOME body
# 537: } else if (roundCount >= task.maxReviewRounds) {
# 538-540: roundBudget body (status=exhausted, note=review budget)
# 541: } else if (outcome === 'reviewer-unavailable') {
# 542: unavailable body
# 543: } else {
# 543: rec.status = 'pending'

# New desired order:
# 1. } else if (roundCount >= task.maxReviewRounds) {  - MOVED UP from 538
# 514: } else if (repeatsKnownFound) {  - MOVED DOWN after OUTCOME block
# 524: } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {  - stays
# 525-536: OUTCOME body  - stays
# 538-540: was roundBudget, now removed/shifted
# 541: } else if (outcome === 'reviewer-unavailable') {  - stays
# 543: } else {  - stays
# 543: rec.status = 'pending'

# I need to extract each block and reassemble them in the new order.

# Let me identify the exact line ranges and content:

# Block 1: repeastKnownFound block
# Starts at line 514 (1-indexed) = 513 (0-based): } else if (repeatsKnownFound) {
# Ends just before the OUTCOME_IS_THE_INFORMATION block
# Lines 514-523 (0-based 513-522): the block and its body

repeats_start = 513  # 0-based index of line 514
# Find the end of the repeastKnownFound block (before OUTCOME block)
# The OUTCOME block starts at line 525 (1-indexed) = 524 (0-based) 
repeats_end = 523  # 0-based, inclusive end of repeast block
# So repeast block = lines[513:523] (0-based, inclusive of start, exclusive of end? Need to be careful)

# Let me just use the actual line content
# repeastKnownFound line: lines[513]
# repeast body: lines[514:523] (lines 515-523 in 1-indexed, which is indices 514-522)

# Actually, let me just identify blocks by searching for their marker lines
# repeastKnownFound marker
repeats_marker_idx = None
for i, line in enumerate(lines):
    if '} else if (repeatsKnownFound) {' in line:
        repeats_marker_idx = i
        break
print('repeastKnownFound marker at 0-based index:', repeats_marker_idx)

# roundBudget marker
budget_marker_idx = None
for i in range(repeats_marker_idx, len(lines)):
    if '} else if (roundCount >= task.maxReviewRounds) {' in lines[i]:
        budget_marker_idx = i
        break
print('roundBudget marker at 0-based index:', budget_marker_idx)

# OUTCOME_IS_THE_INFORMATION marker
outcome_marker_idx = None
for i in range(budget_marker_idx or 0, len(lines)):
    if '} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {' in lines[i]:
        outcome_marker_idx = i
        break
print('OUTCOME_IS_THE_INFORMATION marker at 0-based index:', outcome_marker_idx)

# reviewer-unavailable marker
reviewer_marker_idx = None
for i in range(outcome_marker_idx or 0, len(lines)):
    if '} else if (outcome === "reviewer-unavailable")' in lines[i]:
        reviewer_marker_idx = i
        break
print('reviewer-unavailable marker at 0-based index:', reviewer_marker_idx)

# Now I have the marker positions:
# repeast_start = repeats_marker_idx
# budget_start = budget_marker_idx  
# outcome_start = outcome_marker_idx
# reviewer_end = reviewer_marker_idx (the block ends before this)

# New order: approved -> roundBudget -> OUTCOME -> repeast -> reviewer-unavailable -> else
# I need to extract:
# 1. The content between the approved if and the repeast marker
# # 2. The roundBudget block (from budget_marker_idx to reviewer_marker_idx)
# # 3. The OUTCOME block (from outcome_marker_idx to reviewer_marker_idx)
# # 4. The repeast block (from repeats_marker_idx to outcome_marker_idx)
# # 5. The reviewer-unavailable block (from reviewer_marker_idx to the else block)

# Let me extract these content blocks:

# Content between approved if and repeast marker
# The approved if starts at line 511 (1-indexed) = 510 (0-based)
# I need to find where the approved if block ends and the if-else chain begins

# Let me find the 'if (outcome === 'approved')' line
approved_if_idx = None
for i, line in enumerate(lines):
    if "if (outcome === 'approved')" in line:
        approved_if_idx = i
        break
print('approved if at 0-based index:', approved_if_idx)

# Content from approved if to just before repeast marker
if approved_if_idx is not None and repeats_marker_idx is not None:
    between_approved_and_repeats = ''.join(lines[approved_if_idx+1:repeats_marker_idx])
    print('Content between approved if and repeast (first 200):', between_approved_and_repeats[:200])

# RoundBudget block: from budget_marker_idx to reviewer_marker_idx
if budget_marker_idx is not None and reviewer_marker_idx is not None:
    budget_block = ''.join(lines[budget_marker_idx:reviewer_marker_idx])
    print('roundBudget block length:', len(budget_block))
    print('roundBudget block (first 200):', budget_block[:200])

# OUTCOME block: from outcome_marker_idx to reviewer_marker_idx
if outcome_marker_idx is not None and reviewer_marker_idx is not None:
    outcome_block = ''.join(lines[outcome_marker_idx:reviewer_marker_idx])
    print('OUTCOME block length:', len(outcome_block))
    print('OUTCOME block (first 200):', outcome_block[:200])

# repeast block: from repeats_marker_idx to outcome_marker_idx
if repeats_marker_idx is not None and outcome_marker_idx is not None:
    repeast_block = ''.join(lines[repeats_marker_idx:outcome_marker_idx])
    print('repeast block length:', len(repeast_block))
    print('repeast block (first 200):', repeast_block[:200])

# reviewer-unavailable block: from reviewer_marker_idx to the else block
# Find the '} else {' line
else_marker_idx = None
for i in range(reviewer_marker_idx or 0, len(lines)):
    if lines[i].strip() == '} else {':
        else_marker_idx = i
        break
print('} else { marker at 0-based index:', else_marker_idx)

# reviewer-unavailable block: from reviewer_marker_idx to else_marker_idx
if reviewer_marker_idx is not None and else_marker_idx is not None:
    reviewer_block = ''.join(lines[reviewer_marker_idx:else_marker_idx])
    print('reviewer-unavailable block length:', len(reviewer_block))
    print('reviewer-unavailable block (first 200):', reviewer_block[:200])

# Now I can reconstruct with the new order:
# New order of blocks:
# 1. approved if block content (from approved if to just before repeast marker)
# 2. roundBudget block (from budget_marker_idx to reviewer_marker_idx)
# 3. OUTCOME_IS_THE_INFORMATION block (from outcome_marker_idx to reviewer_marker_idx)
# 4. repeastKnownFound block (from repeats_marker_idx to outcome_marker_idx)
# 5. reviewer-unavailable block (from reviewer_marker_idx to else_marker_idx)
# 6. } else { line

# Let me try to rebuild the content
if all(x is not None for x in [repeats_marker_idx, budget_marker_idx, outcome_marker_idx, 
                                 reviewer_marker_idx, else_marker_idx]):
    
    # Extract each block
    # Block 1: from approved if end to just before repeast marker
    # Actually, let me just get the content from approved if to just before repeast
    # The approved if line is at approved_if_idx, and the if-else chain starts after it
    
    # Let me just extract the blocks I need and reassemble
    # I'll reconstruct the entire status determination section
    
    # Get the content from the approved if to the end
    # The approved if is at approved_if_idx, content from there to else_marker_idx
    main_section = ''.join(lines[approved_if_idx:else_marker_idx+1])
    print('Main section (approved to else) length:', len(main_section))
    print('Main section (first 300):', main_section[:300])
    
    # Now I need to reorder the if-else blocks within this section
    # The current order of if-else conditions within main_section:
    # 1. if (outcome === 'approved') { - this is the first if, already in place
    # 2. } else if (repeatsKnownFound) {  - at position repeats_marker_idx
    # 3. } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {  - at position outcome_marker_idx
    # 4. } else if (roundCount >= task.maxReviewRounds) {  - at position budget_marker_idx
    # 5. } else if (outcome === 'reviewer-unavailable') {  - at reviewer_marker_idx
    # 6. } else {  - at else_marker_idx
    
    # New desired order:
    # 1. if (outcome === 'approved') {  - already first
    # 2. } else if (roundCount >= task.maxReviewRounds) {  - move from position 5 to position 2
    # 3. } else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {  - stays at position 3
    # 4. } else if (repeatsKnownFound) {  - move from position 2 to position 4
    # 5. } else if (outcome === 'reviewer-unavailable') {  - stays at position 5
    # 7. } else {  - stays at position 6
    
    # To achieve this reordering, I need to:
    # - Extract the roundBudget block and move it to after the approved if
    # - Extract the repeastKnownFound block and move it to after the OUTCOME block
    
    # Let me do this by manipulating the main_section string
    # I'll find and replace the specific condition lines
    
    # Find the roundBudget condition in main_section
    budget_cond = '} else if (roundCount >= task.maxReviewRounds) {'
    budget_cond_pos = main_section.find(budget_cond)
    print('budget condition in main_section at:', budget_cond_pos)
    
    # Find the repeastKnownFound condition in main_section
    repeast_cond = '} else if (repeatsKnownFound) {'
    repeast_cond_pos = main_section.find(repeast_cond)
    print('repeast condition in main_section at:', repeast_cond_pos)
    
    # Find the OUTCOME condition in main_section
    outcome_cond = '} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {'
    outcome_cond_pos = main_section.find(outcome_cond)
    print('outcome condition in main_section at:', outcome_cond_pos)
    
    # Now I'll reorder by:
    # 1. Keep the approved if as is
    # 2. Replace the roundBudget condition position with the repeast condition... 
    # No wait, I need to swap their positions.
    
    # Let me try a different approach: I'll just rewrite the entire status determination
    # section by extracting each block and reassembling them.
    
    # Get the exact blocks by their marker positions
    # Round budget block: from budget_marker_idx to reviewer_marker_idx
    budget_block = ''.join(lines[budget_marker_idx:reviewer_marker_idx])
    # OUTCOME block: from outcome_marker_idx to reviewer_marker_idx
    outcome_block = ''.join(lines[outcome_marker_idx:reviewer_marker_idx])
    # Repeast block: from repeats_marker_idx to outcome_marker_idx
    repeast_block = ''.join(lines[repeats_marker_idx:outcome_marker_idx])
    # Reviewer-unavailable block: from reviewer_marker_idx to else_marker_idx
    reviewer_block = ''.join(lines[reviewer_marker_idx:else_marker_idx+1])  # +1 to include the } else { line
    
    print('\\nBlock lengths:')
    print('  budget_block:', len(budget_block))
    print('  outcome_block:', len(outcome_block))
    print('  repeast_block:', len(repeast_block))
    print('  reviewer_block:', len(reviewer_block))
    
    # New order reconstruction:
    # 1. The part before the if-else chain (approved if and setup)
    # 2. roundBudget block
    # 3. OUTCOME_IS_THE_INFORMATION block
    # 3. repeastKnownFound block  (wait, that's wrong - should be 4. repeast block)
    # 5. reviewer-unavailable block
    # 6. else block
    
    # Actually, let me find what's before the if-else chain starts
    # The 'if (outcome === .approved.)' line and its body
    
    # Let me find the content before the if-else chain
    # The first meaningful if-else is at repeats_marker_idx, but there's setup before it
    
    # I think the cleanest approach is to rewrite the entire status determination
    # section by extracting the pieces and putting them in the new order.
    # Let me do this step by step.
    
    # New section content:
    new_section = ''
    
    # Part 1: The approved if block and its body (from approved_if_idx to just before the if-else chain)
    # This is the 'if (outcome === .approved.)' and rec.status = 'done'
    # I need to find where this ends and the else-if chain begins
    
    # Let me just find the content from approved_if_idx to repeats_marker_idx
    approved_to_repeats = ''.join(lines[approved_if_idx:repeats_marker_idx])
    print('\\nApproved to repeast section length:', len(approved_to_repeats))
    
    # Part 2: roundBudget block
    # Part 3: OUTCOME block
    # Part 4: repeast block
    # Part 5: reviewer-unavailable block
    # Part 6: } else { line
    
    # Reconstructed section:
    new_section = (
        '# approved if and setup (kept in place)\n' +
        '# ' + ''.join(lines[approved_if_idx:repeats_marker_idx]) + '\n' +
        '# roundBudget block moved up\n' +
        budget_block + '\n' +
        '# OUTCOME block\n' +
        outcome_block + '\n' +
        '# repeastKnownFound block moved down\n' +
        repeast_block + '\n' +
        '# reviewer-unavailable block\n' +
        reviewer_block + '\n' +
        '# else block\n' +
        lines[else_marker_idx] + '\n' if else_marker_idx < len(lines) else ''
    )
    
    print('\\nNew section constructed, length:', len(new_section))
    print('New section (first 300):', new_section[:300])
    
    # Now replace the status determination section in the original content
    # Find the position of the status determination in the original content
    # It starts after the approved if body and ends at the else block
    
    # Find where the status determination starts in the original file content
    # It should be after the approved if body
    # The approved if is at line 511 (1-indexed) = 510 (0-based)
    # The status determination ends at else_marker_idx
    
    # Find the approved if position in the full content
    # Read the full content file
    with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
        content = f.read()
    
    # Find the approved if position in the full content
    approved_if_str = "if (outcome === 'approved')"
    content_approved_pos = content.find(approved_if_str)
    print('approved if in full content at:', content_approved_pos)
    
    # Find the else marker position in the full content
    else_marker_str = '} else {'
    content_else_pos = content.find(else_marker_str, content_approved_pos)
    print('else marker in full content at:', content_else_pos)
    
    # The section to replace is from content_approved_pos to content_else_pos + len(else_marker_str)
    section_to_replace = content[content_approved_pos:content_else_pos + len(else_marker_str)]
    print('Section to replace length:', len(section_to_replace))
    
    # Replace with the new section
    new_content = content[:content_approved_pos] + new_section + content[content_else_pos + len(else_marker_str):]
    print('New content length:', len(new_content))
    print('Original content length:', len(content))
    
    # Write the new content
    with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
        f.write(new_content)
    print('\\nFile rewritten')
else:
    print('Could not find all marker positions')