#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Define the positions and patterns
# The repeastKnownFound block starts with '} else if (repeatsKnownFound) {'
# The roundBudget block starts with '} else if (roundCount >= task.maxReviewRounds) {'
# The OUTCOME_IS_THE_INFORMATION block starts with '} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {'

# Find the exact positions
pattern_repeats = '} else if (repeatsKnownFound) {'
pattern_budget = '} else if (roundCount >= task.maxReviewRounds) {'
pattern_outcome = '} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {'

idx_repeats = content.find(pattern_repeats)
idx_budget = content.find(pattern_budget)
idx_outcome = content.find(pattern_outcome)

print('repeatsKnownFound at index:', idx_repeats)
print('roundBudget at index:', idx_budget)
print('OUTCOME_IS_THE_INFORMATION at index:', idx_outcome)

# Define what comes after each block
# After repeastKnownFound block: the OUTCOME_IS_THE_INFORMATION block
# After OUTCOME_IS_THE_INFORMATION block: the roundBudget block
# After roundBudget block: the reviewer-unavailable check

# Find the end of each block
# For repeastKnownFound: find the next '} else if' after it
after_repeats = content.find(pattern_outcome, idx_repeats)
print('OUTCOME_IS_THE_INFORMATION after repeats at:', after_repeats)

# For the budget block: find the next '} else if' after it (reviewer-unavailable)
after_budget = content.find('} else if (outcome === "reviewer-unavailable")', idx_budget)
print('reviewer-unavailable after budget at:', after_budget)

# Now I'll reorder the blocks:
# New order should be:
# 1. approved (already in place)
# 2. roundBudget (moved up from position 538)
# 3. OUTCOME_IS_THE_INFORMATION (stays in place)
# 4. repeastKnownFound (moved down from position 514)
# 5. reviewer-unavailable (stays in place)
# 6. else (stays in place)

# Plan:
# 1. Extract the roundBudget block (from idx_budget to after_budget)
# 2. Extract the repeastKnownFound block (from idx_repeats to after_repeats)
# 3. Extract the OUTCOME_IS_THE_INFORMATION block (from idx_outcome to after the reviewers-unavailable check)
# 4. Reconstruct the content with the new order

# Let me first get the exact blocks
repeats_block = content[idx_repeats:after_repeats]
budget_block = content[idx_budget:after_budget]
outcome_block = content[idx_outcome:after_budget]  # from OUTCOME to reviewer-unavailable

print('repeats_block length:', len(repeats_block))
print('budget_block length:', len(budget_block))
print('outcome_block length:', len(outcome_block))

# Now reconstruct the content with new order:
# Original: ... approved -> repeastKnownFound -> OUTCOME_IS_THE_INFORMATION -> roundBudget -> reviewer-unavailable -> else
# New: approved -> roundBudget -> OUTCOME_IS_THE_INFORMATION -> repeastKnownFound -> reviewer-unavailable -> else

# The structure around the affected area:
# Before the affected area: the 'if (outcome === 'approved') {' block and its body
# After the affected area: the '} else {' at the end

# Let me find the boundaries of the section I'm modifying
# Find the 'if (outcome === 'approved') {' line
idx_approved = content.find("if (outcome === 'approved')")
# Find the final '} else {'
idx_else = content.rfind('} else {')

# The section I'm modifying is between the approved check and the final else
# Current order within this section:
# repeastKnownFound -> OUTCOME_IS_THE_INFORMATION -> roundBudget -> reviewer-unavailable -> else

# New order: approved -> roundBudget -> OUTCOME_IS_THE_INFORMATION -> repeastKnownFound -> reviewer-unavailable -> else

# Let me extract the pieces:
# 1. The approved check and body (from idx_approved to just before idx_repeats)
# Actually, let me find what's between the approved check and the repeastKnownFound block
idx_after_approved = content.find(pattern_repeats, idx_approved)
section_before_repeats = content[idx_approved:idx_after_approved]
print('Section before repeats (first 100):', section_before_repeats[:100])

# Find what's after the outcome block
after_outcome = content[after_repeats:]  # everything after the OUTCOME block
print('After outcome (first 100):', after_outcome[:100])

# I need to insert the roundBudget block after the approved check and before the OUTCOME block
# And insert the repeastKnownFound block after the OUTCOME block but before the reviewer-unavailable check

# Let me find the exact insertion points
# The approved check ends and the if-else chain continues
# I'll insert roundBudget right after the approved check's closing

# Actually, let me try a completely different simpler approach:
# Just swap the two if-else conditions by replacing their exact text strings

# Find the repeastKnownFound block's closing and the roundBudget block's closing
# The repeastKnownFound block ends just before the OUTCOME_IS_THE_INFORMATION block
# The roundBudget block ends just before the reviewer-unavailable check

# Let me just replace the condition lines and swap their bodies
# This is getting too complex. Let me try a simpler approach.

# What if I just change the condition in the repeastKnownFound block to also check roundCount?
# No, that weakens the safety.

# What if I just add a check: if roundCount >= maxReviewRounds, then exhausted, 
# BEFORE the repeastKnownFound check? I can do this by adding an early check at the 
# beginning of the status determination section.

print('\\nTrying simpler approach: add budget check at the beginning of status determination')
# Add a budget check right after the outcome === 'approved' check, before anything else
# This way, the budget is always checked first

# Find the position after 'if (outcome === 'approved') {' and its body
# The approved check starts at idx_approved, and its body ends before the if-else chain

# Let me find a new position to insert the budget check
# I'll insert it between the approved check and the repeastKnownFound check

# Get the content between approved and repeastKnownFound
idx_after_approved_body = content.find(pattern_repeats, idx_approved if 'idx_approved' in dir() else 0)
section_between = content[idx_approved:idx_after_approved]
print('Between approved and repeats (first 200):', section_between[:200])

# I'll insert a budget check after the approved status is set, but before the if-else chain
# Actually, the simplest approach: just modify the if-else chain order by repositioning the blocks

# Let me try yet another approach: just directly swap the two 'else if' condition lines
# and their associated blocks by working with the raw string positions

# Get the exact repeastKnownFound block (from its '} else if' to just before the OUTCOME block)
repeats_full_block = content[idx_repeats:after_repeats]
# Get the roundBudget block (from its '} else if' to just before the reviewer-unavailable check)
budget_full_block = content[idx_budget:after_budget]

print('\\nRepeats block full length:', len(repeats_full_block))
print('Budget block full length:', len(budget_full_block))

# Now I'll replace the repeastKnownFound block position with the budget block,
# and the budget block position with the repeastKnownFound block
# But since they're different lengths, I need to adjust

# Calculate the difference in length
diff = len(budget_full_block) - len(repeats_full_block)
print('Length difference (budget - repeats):', diff)

# New content: replace the repeats block position with the budget block
# and the budget block position with the adjusted repeats block
new_content = content[:idx_repeats] + budget_block + content[idx_repeats + len(repeats_full_block):]
# Now insert the adjusted repeats block after the budget block position
# The budget block originally started at idx_budget, but now the content has shifted
# The new position for the repeastKnownFound block should be after the budget block

# Get the content after the original budget block position
after_budget_original = content[idx_budget:idx_budget+100]
print('After original budget position:', after_budget_original[:100])

# Insert the repeats block after what was originally the budget block position
# The new content after the budget block insertion
new_content2 = new_content[:idx_budget] + repeats_block + new_content[idx_budget:]

print('\\nNew content length:', len(new_content2))
print('Original content length:', len(content))

# Check if the new content has the right patterns at the right places
# Check if roundBudget condition is now earlier
if '} else if (roundCount >= task.maxReviewRounds) {' in new_content2[:5000]:
    print('roundBudget condition found in first 5000 chars - GOOD')
else:
    print('roundBudget condition NOT found in first 5000 chars - BAD')

if '} else if (repeatsKnownFound) {' in new_content2[5000:10000]:
    print('repeatsKnownFound condition found in chars 5000-10000 - GOOD')
else:
    print('repeatsKnownFound condition NOT found in chars 5000-10000 - BAD')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(new_content2)
print('\\nFile written with new block order')