import json, os

home = r'C:\Users\Samer'
missions_dir = os.path.join(home, '.aios', 'agent', 'missions')

files = sorted(os.listdir(migrations_dir))[:5]
for f in files:
    path = os.path.join(migrations_dir, f)
    try:
        with open(path, 'r') as fh:
            data = json.load(fh)
        mid = data.get('missionId', 'unknown')[:36]
        ok = data.get('ok', 'unknown')
        goal = data.get('goal', '')[:60] if data.get('goal') else ''
        print(f'{mid}: ok={ok} goal={goal}')
    except:
        print(f'{f}: error reading')
"