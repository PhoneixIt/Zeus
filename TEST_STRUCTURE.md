## Mission ExecutionTest Structure (from earlier exploration)

Test files in packages/mission/test/:
- agent.test.ts - 47 tests (14 added pinning accepted flag bug fix and capability rule)
- persistence.test.ts - self-check tests
- expected-content.test.ts - planner tests
- folder-label.test.ts - folder mode tests

Execute function return paths (5 total):
1. reviewedProposalDigest - early refusal2. unsatisfiable dependencies 
3. mission start recording failure
4. Normal execution (falls through to finalize)
5. Normal failure/refusal

Key observation: All existing missions have ok=False. None have ok=True.

The 33 type errors in typecheck are ALL pre-existingin other files (agent.ts, capabilities.ts, folder/, auto-recovery.ts, model-folder-mission.ts, folder-label.test.ts) - NONE are in mission/execute.ts from my changes.