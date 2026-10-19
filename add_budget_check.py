#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Find the status determination section
# I need to add a budget check before the repeatsKnownFound check
# The best place is right after the outcome determination and before the if-else chain for status

# Find 'const roundCount = rec.rounds.filter' which is used in the status determination
idx_roundcount = content.find('const roundCount = rec.rounds.filter')
print('roundCount at index:', idx_roundcount)

# Find the status determination starts
# Look for the 'const outcome' line
idx_outcome = content.find("const outcome = passed === false ? 'verification-failed'")
print('outcome at index:', idx_outcome)

# The status determination starts after the outcome is determined and the review is processed
# I'll insert a budget check right after the outcome and review processing, but before the repeatsKnownFound check

# Let me find the 'repeatsKnownFound' line
idx_repeats = content.find('const repeatsKnownFinding =')
print('repeatsKnownFinding at index:', idx_repeats)

# The idea: insert a budget check after the review is processed and the roundCount is computed,
# but before the repeatsKnownFound check evaluates
# Actually, the roundCount is already computed at line 509, before the status determination

# Let me look at the structure more carefully
# After line 510 (roundCount computation), the status determination starts at line 511
# I need to insert the budget check between the roundCount computation and the status determination

# Let me find a good insertion point: after the 'const roundCount' line and before the status if-else chain
idx_after_roundcount = idx_roundcount + len('const roundCount = rec.rounds.filter((r) => r.role === \'reviewer\').length\n')

# Get the content after roundCount
after_roundcount = content[idx_after_roundcount:idx_after_roundcount+500]
print('After roundCount (first 300):', after_roundcount[:300])

# I need to insert: 'if (roundCount >= task.maxReviewRounds) { rec.status = \'exhausted\'; ... }'
# But this would be an early return, which changes the flow significantly

# Actually, a simpler approach: I'll just reorder the existing if-else blocks
# by swapping the 'repeatsKnownFound' and 'roundCount' conditions in the source

# Let me try to find and directly swap the two else-if blocks
# The repeastKnownFound block starts with '} else if (repeatsKnownFound) {'
# The roundBudget block starts with '} else if (roundCount >= task.maxReviewRounds) {'

# Let me find these in the current content (the indices from earlier search failed, so let me search anew)
idx_r = content.find('} else if (repeatsKnownFound) {')
idx_b = content.find('} else if (roundCount >= task.maxReviewRounds) {')
print('repeatsKnownFound at:', idx_r)
print('roundBudget at:', idx_b)

if idx_r >= 0 and idx_b >= 0:
    # Extract the blocks
    # Find what's between idx_r and idx_b (the repeastKnownFound block content)
    between = content[idx_r:idx_b]
    print('Between blocks length:', len(between))
    
    # Find what's after idx_b (the roundBudget block content and beyond)
    after_b = content[idx_b:idx_b+500]
    print('After budget (first 200):', after_b[:200])
    
    # Now I'll swap: replace the repeastKnownFound block position with the budget block,
    # and the budget block position with the repeastKnownFound block
    # But I need to handle the different block lengths
    
    # Get the full repeastKnownFound block (from idx_r to after the status setting and blockers)
    # Find the end of the repeastKnownFound block (the line with the blockers push and the closing)
    # The repeastKnownFound block ends with 'this.state.blockers.push' and then the next '} else if'
    end_repeats = content.find('} else if (OUTCOME_IS_THE_INFORMATION.has(outcome) && rec.repeatedOutcome >= 2)', idx_r)
    if end_repeats == -1:
        end_repeats = content.find('} else if (roundCount >= task.maxReviewRounds)', idx_r)
    if end_repeats == -1:
        end_repeats = content.find('} else if (outcome === "reviewer-unavailable")', idx_r)
    
    print('End of repeast block at:', end_repeats)
    
    if end_repeats > idx_r:
        full_repeats_block = content[idx_r:end_repeats]
        print('Full repeats block length:', len(full_repeats_block))
    else:
        full_repeats_block = content[idx_r:idx_b] if idx_b > idx_r else content[idx_r:]
        print('Full repeats block (adjusted) length:', len(full_repeats_block))
    
    # Get the full budget block
    # Find the end of the budget block (before reviewer-unavailable)
    end_budget = content.find('} else if (outcome === "reviewer-unavailable")', idx_b)
    if end_budget == -1:
        end_budget = len(content)
    full_budget_block = content[idx_b:end_budget]
    print('Full budget block length:', len(full_budget_block))
    
    # Now swap: replace the repeast block position with the budget block,
    # and the budget block position with the repeast block (adjusted for length difference)
    
    diff = len(full_budget_block) - len(full_repeats_block)
    print('Length difference (budget - repeats):', diff)
    
    # New content: replace repeats block position with budget block
    new_content = content[:idx_r] + full_budget_block + content[idx_r + len(full_repeats_block):]
    print('After first replacement, length:', len(new_content))
    
    # Now insert the repeats block after the budget block position
    # The budget block originally started at idx_b, but now the content has shifted
    # The new position for the repeast block should account for the length difference
    new_content2 = new_content[:idx_b] + full_repeats_block + new_content[idx_b + diff:] if diff != 0 else new_content[:idx_b] + full_repeats_block + new_content[idx_b:]
    
    print('New content length:', len(new_content2))
    print('Original content length:', len(content))
    
    # Check if the swap worked
    if '} else if (roundCount >= task.maxReviewRounds) {' in new_content2[:5000]:
        print('roundBudget condition found early - GOOD')
    else:
        print('roundBudget condition NOT found early - check needed')
    
    if '} else if (repeatsKnownFound) {' in new_content2[5000:10000]:
        print('repeatsKnownFound condition found later - GOOD')
    else:
        print('repeatsKnownFound condition NOT found later - check needed')
    
    with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
        f.write(new_content2)
    print('\\nFile written')
else:
    print('Could not find both patterns')