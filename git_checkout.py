#!/usr/bin/env python3
import subprocess

# Try git checkout -- packages/agent/orchestrator.ts
result = subprocess.run(
    ['git', '-C', 'C:\\Users\\Samer\\Projects\\AIOS', 'checkout', '--', 'packages/agent/orchestrator.ts'],
    capture_output=True, text=True, timeout=30
)
print("stdout:", result.stdout)
print("stderr:", result.stderr[:200] if result.stderr else "no stderr")
print("return code:", result.returncode)
PYEOF