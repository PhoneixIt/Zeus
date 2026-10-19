import sys

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# Find and replace the exact section
old = """    const rec = this.state.tasks.find((t) => t.id === task.id)
    if (!rec) throw new Error(`task ${task.id} is not in the queue`)
    const round = rec.rounds.length"""

new = """    const rec = this.state.tasks.find((t) => t.id === task.id)
    if (!rec) throw new Error(`task ${task.id} is not in the queue`)
    if (rec.status === 'done' || rec.status === 'exhausted') {
      return { implement: Orchestrator.emptyState('o', 'a', 'r').implement, review: null, record: rec }
    }
    const round = rec.rounds.length"""

if old in content:
    content = content.replace(old, new)
    with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
        f.write(content)
    print("Replacement successful")
else:
    print("Old string not found")
    # Show what's around line 352
    lines = content.split('\n')
    for i in range(351, 356):
        print(f"Line {i}: {repr(lines[i])}")