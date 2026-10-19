#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

idx_repeats = 22144
idx_budget = 23811

# Extract the repeatsKnownFinding block (from idx_repeats to just before the OUTCOME_IS_THE_INFORMATION block)
# And the roundBudget block (from idx_budget to just before the reviewer-unavailable check)

# First, let me find the exact boundaries
# The repeatsKnownFinding block: from idx_repeats to the line with rec.status = 'exhausted' and blockers push
# The roundBudget block: from idx_budget to the line with rec.status = 'exhausted' and the next '} else if'

# Let me find the actual line numbers by searching from these positions
# Actually, let me just use string replacement with the known content

# The repeatsKnownFinding block content (I'll extract it by finding its start and the line after it)
# Let me extract from idx_repeats to idx_budget (which is the start of the budget block)
repeats_block = content[idx_repeats:idx_budget]
print('repeats block length:', len(repeats_block))

# The roundBudget block content (from idx_budget to after the status setting and blockers)
# Find the end of the budget block - it ends with 'this.state.blockers.push' followed by the next '} else if'
budget_block_end = content.find('} else if (outcome === \"reviewer-unavailable\")', idx_budget)
if budget_block_end == -1:
    budget_block_end = content.find('} else {', idx_budget)
if budget_block_end == -1:
    budget_block_end = len(content)
budget_block = content[idx_budget:budget_block_end]
print('budget block length:', len(budget_block))

# Now I need to swap these two blocks
# Replace the repeatsKnownFinding block with the roundBudget block
# The repeatsKnownFinding block is from some earlier position to idx_repeats + len(repeats_block)
# Actually, idx_repeats is the START of the repeatsKnownFinding block
# And idx_budget is the START of the roundBudget block

# What's between the start of repeatsKnownFinding and the start of roundBudget?
# It's just the repeatsKnownFinding block itself (since they're consecutive in the if-else chain)

# So I need to:
# 1. Replace the content at idx_repeats with the budget block
# 2. Replace the content at idx_budget with the repeats block

# But I need to make sure the lengths are compatible or adjust accordingly
len_repeats = len(repeats_block)
len_budget = len(budget_block)

print('Repeats block length:', len_repeats)
print('Budget block length:', len_budget)

if len_repeats == len_budget:
    print('Lengths match - can directly swap')
else:
    print('Lengths differ - need adjusted approach')
    # The repeats block is 1667 chars, budget block might be different
    # Let me check the budget block length more carefully
"