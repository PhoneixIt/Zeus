import re, io, os

LIVE = r'C:\Users\Samer\Projects\AIOS\packages\mission-engine\live'
HARNESSES = ['run-world-aware','run-two-step','run-recovery','run-model-mission',
             'run-live-mission','run-gui-accept','run-folder-mission','run-filesystem',
             'run-durable-mission','run-cross-tool-mission','run-auto-recovery','run-approval',
             'run-interact-mission','run-fs-ops-mission','run-model-folder-mission',
             'run-local-model-mission','run-repo-mission','run-browser-mission',
             'run-folder-summary','run-summary-mission','run-navigation-mission']

EV = ['file-exists','directory-present','folder-contents','summary-composed','file-written',
      'file-read-back','file-deleted','command-verified','window-present','screen-text-present',
      'input-attributed','input-unattributed','http-status','command-exit-code','process-exited',
      'api-response']

print('%-28s %-46s %s' % ('HARNESS', 'OBJECTIVE (literal, truncated)', 'EVIDENCE KINDS CONSTRUCTED IN FILE'))
print('-' * 150)
for h in sorted(HARNESSES):
    p = os.path.join(LIVE, h + '.ts')
    if not os.path.exists(p):
        print('%-28s %s' % (h, '(file not found)'))
        continue
    s = io.open(p, encoding='utf-8').read()
    objs = re.findall(r"runMission\(\s*'([^']{0,70})", s)
    obj = objs[0] if objs else '(not via runMission literal)'
    evs = sorted({k for k in EV if re.search(r"kind:\s*'" + re.escape(k) + r"'", s)})
    print('%-28s %-46s %s' % (h, obj[:44], ','.join(evs) if evs else '-none-'))