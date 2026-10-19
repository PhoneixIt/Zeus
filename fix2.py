with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Find the line with "const round = rec.rounds.length" and insert before it
new_lines = []
for i, line in enumerate(lines):
    new_lines.append(line)
    if 'const round = rec.rounds.length' in line and 350 < i < 365:
        # Insert the early return check before this line
        new_lines.append('    if (rec.status === \'done\' || rec.status === \'exhausted\') {\n')
        new_lines.append('      return { implement: Orchestrator.emptyState(\'o\', \'a\', \'r\').implement, review: null, record: rec }\n')
        new_lines.append('    }\n')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(new_lines)
print("Done")