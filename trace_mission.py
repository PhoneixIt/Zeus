import json, os

home = r'C:\Users\Samer'
missions_dir = os.path.join(home, '.aios', 'agent', 'missions')
files = os.listdir(missions_dir)

# Show all missions with their ok status and key fields
for f in files:
    path = os.path.join(missions_dir, f)
    try:
        with open(path, 'r') as fh:
            data = json.load(fh)
        mid = data.get('missionId', '?')[:36]
        ok = data.get('ok', 'MISSING')
        steps = len(data.get('steps', []))
        error = data.get('error', '')[:50] if data.get('error') else ''
        has_done = 'done' in str(data)
        print(f'{mid}: ok={ok}, steps={steps}, error={error!r}, has_done_ish={has_done}')
    except Exception as e:
        print(f'{f}: ERROR reading: {e}')