#!/usr/bin/env python3
import sys

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

idx_repeats = 22144
idx_budget = 23811

# Extract the two blocks
repeats_block = content[idx_repeats:idx_budget]
budget_block = content[idx_budget:idx_budget+2000]  # read enough

print('Repeats block (first 200):', repeats_block[:200])
print('Budget block (first 200):', budget_block[:200])
print()
print('Repeats block length:', len(repeats_block))
print('Budget block (up to 2000 chars):', budget_block[:2000][:200])

# Find the true end of the budget block - it ends before the next '} else if'
# Look for the pattern that marks the end of the budget block
# The budget block ends with the blockers push, then the next else if
search_pattern = '} else if (outcome ==='
pos = content.find(search_pattern, idx_budget)
print('Found next else-if at position:', pos)

# Get the budget block from idx_budget to pos
budget_block = content[idx_budget:pos]
print('Budget block (exact):', budget_block[:300])
print('Budget block length:', len(budget_block))

# Get the repeats block from idx_repeats to pos (which is where budget block starts)
repeats_block = content[idx_repeats:pos] if pos > idx_repeats else content[idx_repeats:idx_budget+500]
print('Repeats block (adjusted):', repeats_block[:300])
print('Repeats block length:', len(repeats_block))