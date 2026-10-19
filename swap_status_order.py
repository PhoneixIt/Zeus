#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# The status determination section is around lines 509-547 (1-indexed)
# Currently the order is:
# Line 514: } else if (repeatsKnownFinding) {  -> exhausted
# ...
# Line 538: } else if (roundCount >= task.maxReviewRounds) {  -> exhausted
# We need to swap these so the budget check comes first.

# Find the lines to swap
# Line 514 (index 151 in 0-based if the file starts at line 1, but let me just search for the patterns)

# Find the repeatsKnownFinding block
repeats_known_start = None
repeats_known_end = None
round_budget_start = None
round_budget_end = None

for i, line in enumerate(lines):
    if 'repeatsKnownFinding' in line and i > 500 and i < 520:
        repeats_known_start = i
    # Find the end of the repeatsKnownFinding block (look for the next } else if or the end pattern)
    if repeats_known_start is not None and i > repeats_known_start and '}' in line and i - repeats_known_start > 5:
        # Check if this closing brace is for the repeatsKnownFinding block
        # The block spans from repeats_known_start to the line with just '}' that closes it
        # Actually, let me just find the specific patterns
        pass

# Let me just use a different approach - find the specific line numbers by searching for the patterns
for i, line in enumerate(lines):
    if 'repeatsKnownFinding' in line and 'rec.status = ' in lines[i+1] if i+1 < len(lines) else False:
        if 'exhausted' in lines[i+1] if i+1 < len(lines) else False:
            repeats_known_start = i
            print(f'repeatsKnownFinding at line {i+1}')
    if 'roundCount >= task.maxReviewRounds' in line:
        round_budget_start = i
        print(f'roundCount check at line {i+1}')

# Now let me just directly swap the sections by finding their exact positions
# The repeatsKnownFinding block starts at line 514 (1-indexed) and ends at line 523 (1-indexed)
# The roundBudget check starts at line 538 (1-indexed) and ends at line 541 (1-indexed)

# In 0-based indexing:
repeats_known_0based = None
round_budget_0based = None

for i, line in enumerate(lines):
    if i > 500 and 'repeatsKnownFinding' in line and i < 520:
        repeats_known_0based = i
    if 'roundCount >= task.maxReviewRounds' in line and i > 530:
        round_budget_0based = i
        break

print(f'repeatsKnownFinding at 0-based index: {repeats_known_0based}')
print(f'roundCount check at 0-based index: {round_budget_0based}')

# Now let me swap the content between these two blocks
# First, let me identify the exact content of each block

# The repeatsKnownFinding block: from line repeats_known_0based to the line that sets status to exhausted
# The roundBudget block: from line round_budget_0based to the line that sets status to exhausted

# Actually, let me just swap the conditions and their associated code blocks
# I'll move the roundCount check to just after the repeatsKnownFinding check... no, I need to swap their positions

# Let me take a simpler approach: just move the roundCount >= maxReviewRounds check
# to be right after the repeatsKnownFinding check, effectively swapping their evaluation order.

# Find the line indices
if repeats_known_0based is not None and round_budget_0based is not None:
    # Get the content of the roundBudget block (from round_budget to the exhausted status setting)
    # and the repeatsKnownFinding block content
    
    # Simpler approach: just swap the 'else if' lines and their immediate bodies
    # Get the roundBudget block content (lines round_budget_0based to the line with rec.status = 'exhausted')
    # and the repeatsKnownFinding block content (lines repeats_known_0based to the line with rec.status = 'exhausted')
    
    # Get the round budget block (from round_budget_0based to include the status setting and blockers)
    budget_block_end = None
    for i in range(round_budget_0based, min(len(lines), round_budget_0based + 15)):
        if 'rec.status = 'exhausted'' in lines[i]:
            budget_block_end = i + 1  # include this line
            break
    
    if budget_block_end:
        budget_block = lines[round_budget_0based:budget_block_end]
        print('Budget block:', [l.rstrip() for l in budget_block])
    
    # Get the repeatsKnownFinding block
    known_block_end = None
    for i in range(repeats_known_0based, min(len(lines), repeats_known_0based + 20)):
        if 'rec.status = 'exhausted'' in lines[i]:
            known_block_end = i + 1
            break
    
    if known_block_end:
        known_block = lines[repeats_known_0based:known_block_end]
        print('Known block:', [l.rstrip() for l in known_block])