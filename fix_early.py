with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Remove the early return check (lines 356-358)
# Keep lines 352-355 and 359+
new_lines = []
for i, line in enumerate(lines):
    # Skip the early return check lines
    if i == 355:  # const round = rec.rounds.length
        new_lines.append(line)
    elif i == 356:  # if (rec.status === 'done' || rec.status === 'exhausted') {
        # Skip this line and the next two (the if body and closing }
        # But we need to keep the code flow going, so just don't add these lines
        # Actually, we need to remove lines 356-358 entirely
        # Line 356: if (rec.status === 'done' || rec.status === 'exhausted') {
        # Line 357:   return { implement: Orchestrator.emptyState('o', 'a', 'r').implement, review: null, record: rec }
        # Line 358: }
        # So we skip indices 356, 357, 358 (0-based: 355, 356, 357)
        pass
    elif i == 357:
        pass
    elif i == 358:
        pass
    else:
        new_lines.append(line)

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(new_lines)
print("Early return removed")