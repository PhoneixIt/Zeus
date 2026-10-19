with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Remove lines 356-358 (the early return if block that broke the syntax)
# These lines are: 
#   356:     if (rec.status === 'done' || rec.status === 'exhausted') {
#   357:     const cycleStart = Date.now()
#   358:     this.persist()
# We need to remove them and adjust indentation for line 359 (which is blank) and line 360+

new_lines = []
for i, line in enumerate(lines):
    # Skip lines 356-358 (0-based indices 355-357)
    if i in (355, 356, 357):
        # Don't add these lines
        # But we need to track the brace balance
        # Line 356 has '{' - we need to account for that
        if i == 355:  # if (rec.status === 'done' || rec.status === 'exhausted') {
            # This line has a '{' that needs a matching '}'
            # But since we're removing it, we just skip it
            pass
        elif i == 356:  # const cycleStart = Date.now()
            pass
        elif i == 357:  # this.persist()
            pass
    else:
        new_lines.append(line)

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(new_lines)
print("Early return block removed, file rewritten")