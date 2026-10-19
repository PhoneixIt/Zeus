with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

# Add early return check after "if (!rec) throw new Error(...)" and before "const round = rec.rounds.length"
# The check should be: if (rec.status === 'done' || rec.status === 'exhausted') return early

# Find the line with "if (!rec) throw new Error(`task ${task.id} is not in the queue`)"
for i, line in enumerate(lines):
    if 'if (!rec) throw new Error(`task ' in line:
        # Insert the early return check after this line
        # But we need to be careful about the existing "const round = rec.rounds.length" line
        # Let's insert after this line, before the round line
        
        early_return = """    if (rec.status === 'done' || rec.status === 'exhausted') {
      return { implement: Orchestrator.emptyState('o', 'a', 'r').implement, review: null, record: rec }
    }"""
        
        # Insert after line i, before line i+1
        lines.insert(i + 1, early_return)
        print(f"Early return added after line {i+1}")
        break

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(lines)
print("Done")