import json, os

home = r'C:\Users\Samer'
missions_dir = os.path.join(home, '.aios', 'agent', 'missions')
files = os.listdir(migrations_dir)
ok_true = 0
ok_false = 0
no_ok = 0
for f in files:
    path = os.path.join(migrations_dir, f)
    try:
        with open(path, 'r') as fh:
            data = json.load(fh)
        ok = data.get('ok', 'unknown')
        if ok == True:
            ok_true += 1
        elif ok == False:
            ok_false += 1
        else:
            no_ok += 1
    except:
        no_ok += 1

print('Total missions:', len(files))
print('ok=True:', ok_true)
print('ok=False:', ok_false)
print('No ok field:', no_ok)