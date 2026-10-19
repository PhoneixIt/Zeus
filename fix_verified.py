with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if 'verifiedMilestone: ' in line and 'none' in line:
        print(f'Line {i+1}: {lines[i].rstrip()}')

# Replace 'none' with '' 
for i, line in enumerate(lines):
    if 'verifiedMilestone: ' in line and 'none' in line:
        # Replace the 'none' part
        new_line = line.replace(": 'none'", ": ''")
        lines[i] = new_line
        print(f'Replaced line {i+1}: {new_line.rstrip()}')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
    f.writelines(lines)
print("Done")