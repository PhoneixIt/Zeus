import json
import urllib.request
import urllib.error
import os

home = os.environ.get('HOME', r'C:\Users\Samer')
server_path = os.path.join(home, '.aios', 'agent', 'server.json')
with open(server_path, 'r') as f:
    server_data = json.load(f)

token = server_data['token']
port = server_data['port']
base = f'http://127.0.0.1:{port}'
mission_id = '89f265ae-cd3f-4fb1-8651-e42e70f76d74'

# Check /missions for this specific mission
req = urllib.request.Request(
    f'{base}/missions',
    headers={'Authorization': f'Bearer {token}'}
)

try:
    with urllib.request.urlopen(req) as resp:
        result = json.load(resp)
        missions = result.get('missions', [])
        # Find our mission
        found = False
        for m in missions:
            if m.get('missionId') == mission_id:
                print('=== MISSION RECORD ===')
                print(json.dumps(m, indent=2))
                found = True
                break
        if not found:
            print('Mission not found in last 50')
            # Show first few
            for m in missions[:3]:
                mid = m.get('missionId', 'unknown')
                ok = m.get('ok', 'unknown')
                goal = m.get('goal', '')[:60] if m.get('goal') else ''
                print(f'  {mid}: ok={ok} goal={goal}')
except urllib.error.HTTPError as e:
    print(f'/missions HTTP error: {e.code}')
    body = e.read()
    try:
        result = json.loads(body)
        print(json.dumps(result, indent=2)[:600])
    except:
        try:
            raw = body.decode('utf-8', errors='replace')
            print(f'Raw: {raw[:600]}')
        except:
            print(f'Raw: (binary)')
except Exception as e:
    print(f'Error: {e}')

# Also check the done event details from /progress
# The mission had 6 events - let me check /progress with since=0
req2 = urllib.request.Request(
    f'{base}/progress?since=0',
    headers={'Authorization': f'Bearer {token}'}
)

try:
    with urllib.request.urlopen(req2) as resp2:
        result2 = json.load(resp2)
        events = result2.get('events', [])
        print(f'\=== EVENTS ({len(events)}) ===')
        for i, evt in enumerate(events):
            kind = evt.get('kind', 'unknown')
            summary = evt.get('summary', '')[:80] if evt.get('summary') else 'no summary'
            missionId = evt.get('missionId', '')
            print(f'  [{i}] kind={kind} summary={summary} missionId={missionId}')
except urllib.error.HTTPError as e2:
    print(f'/progress HTTP error: {e2.code}')
    body2 = e2.read()
    try:
        result2 = json.loads(body2)
        print(json.dumps(result2, indent=2)[:600])
    except:
        try:
            raw2 = body2.decode('utf-8', errors='replace')
            print(f'Raw: {raw2[:600]}')
        except:
            print(f'Raw: (binary)')
except Exception as e2:
    print(f'Error: {e2}')