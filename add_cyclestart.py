with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Add const cycleStart = Date.now() after line 355 (const round = rec.rounds.length)
# Insert at index 356 (after the round line)
new_line = "    const cycleStart = Date.now()\n"
# Insert after line 355 (0-based index 355)
lines.insert(356, new_line)

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(lines)
print("cycleStart added")