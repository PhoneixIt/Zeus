#!/usr/bin/env python3
import re

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Find the positions of the two blocks we need to swap
# repeastKnownFound block starts with '} else if (repeatsKnownFound) {'
# roundBudget block starts with '} else if (roundCount >= task.maxReviewRounds) {'

repeats_marker = '} else if (repeatsKnownFound) {'
budget_marker = '} else if (roundCount >= task.maxReviewRounds) {'

repeats_pos = content.find(repeats_marker)
budget_pos = content.find(budget_marker)

print('repeatsKnownFound at position:', repeats_pos)
print('roundBudget at position:', budget_pos)

if repeats_pos < 0 or budget_pos < 0:
    print('Could not find markers')
    exit(1)

# Find the end of each block
# For repeastKnownFound: find the next '} else if' after it
# The repeast block ends just before the OUTCOME_IS_THE_INFORMATION block
outcome_marker = '} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2) {'
outcome_pos = content.find(outcome_marker, repeats_pos)
print('OUTCOME_IS_THE_INFORMATION at position:', outcome_pos)

# For roundBudget block: find the next '} else if (outcome === "reviewer-unavailable")' after it
reviewer_marker = '} else if (outcome === "reviewer-unavailable")'
reviewer_pos = content.find(reviewer_marker, budget_pos)
print('reviewer-unavailable at position:', reviewer_pos)

# Extract the two blocks
# repeast block: from repeats_pos to outcome_pos
repeats_block = content[repeats_pos:outcome_pos]
print('repeats block length:', len(repeats_block))

# budget block: from budget_pos to reviewer_pos
budget_block = content[budget_pos:reviewer_pos]
print('budget block length:', len(budget_block))

# Now swap them: 
# New content: replace the repeats block position with the budget block,
# and the budget block position with the repeast block
# But since the blocks have different lengths, I need to adjust

# The approach: 
# 1. Replace the repeats block position (repeats_pos) with the budget block
# 2. Adjust the budget block position content, then insert the repeast block
#    at the original repeats position, shifted by the length difference

# Step 1: Replace repeats position with budget block
new_content = content[:repeats_pos] + budget_block + content[repeats_pos + len(repeats_block):]
print('After first replacement, length:', len(new_content))

# Step 2: Insert the repeast block after the budget block position
# The budget block originally started at budget_pos, but now the content has shifted
# The new position for the repeast block should be at budget_pos + len(budget_block)
# (which is where the budget block ended up after the first replacement)

# Calculate the shift
shift = len(budget_block) - len(repeats_block)
print('Length difference (budget - repeats):', shift)

# Insert the repeast block at the right position
# The repeast block should go after the budget block content
new_content2 = new_content[:budget_pos + len(budget_block)] + repeast_block + new_content[budget_pos + len(budget_block):]

print('New content length:', len(new_content2))
print('Original content length:', len(content))

# Check if the swap worked by looking for the conditions in the new content
if '} else if (roundCount >= task.maxReviewRounds) {' in new_content2[:3000]:
    print('roundBudget condition found early in new content - GOOD')
else:
    print('roundBudget condition NOT found early - BAD')

if '} else if (repeatsKnownFound) {' in new_content2[3000:6000]:
    print('repeatsKnownFound condition found in middle - GOOD')
else:
    print('repeatsKnownFound condition NOT found in middle - BAD')

# Write the new content
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.write(new_content2)
print('\\nFile rewritten with swapped blocks')