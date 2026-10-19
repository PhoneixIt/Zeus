import json, os

home = r'C:\Users\Samer'
missions_dir = os.path.join(home, '.aios', 'agent', 'missions')

# Show first mission
first_file = os.path.join(migrations_dir, '00fb6c67-38c3-4ccf-98f3-5a3ba2b48375.json')
with open(first_file, 'r') as f:
    first_data = json.load(f)
print('First mission (persisted):')
print('  ok:', first_data.get('ok'))
print('  steps:', len(first_data.get('steps', [])))
goal = first_data.get('goal', '')
if goal:
    print('  goal:', goal[:50])
else:
    print('  goal: (empty)')

# Find an ok=true mission
for f in os.listdir(migrations_dir):
    path = os.path.join(migrations_dir, f)
    try:
        with open(path, 'r') as fh:
            data = json.load(fh)
        if data.get('ok') == True:
            print()
            print('Found ok=true mission:')
            mid = data.get('missionId', '?')[:36]
            print('  missionId:', mid)
            print('  goal:', data.get('goal', '')[:50])
            print('  steps:', len(data.get('steps', [])))
            break
    except:
        pass
else:
    print()
    print('No ok=true mission found in listings')
"