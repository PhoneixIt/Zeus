import io

test_path = r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts'
add_path = r'C:\Users\Samer\Projects\AIOS\regression_tests.ts'

body = io.open(add_path, encoding='utf-8').read()
test_src = io.open(test_path, encoding='utf-8').read()

# The new tests use evidenceFingerprint, which is not yet imported by the test file.
old_import = "import { Orchestrator, type Task, type Reviewer, type ReviewVerdict } from '../orchestrator.ts'"
new_import = "import { Orchestrator, evidenceFingerprint, type Task, type Reviewer, type ReviewVerdict } from '../orchestrator.ts'"
assert test_src.count(old_import) == 1, test_src.count(old_import)
test_src = test_src.replace(old_import, new_import)

# Append the regression block at the end of the file.
test_src = test_src.rstrip() + '\n\n' + body

io.open(test_path, 'w', encoding='utf-8').write(test_src)
print('appended regression tests and added evidenceFingerprint import')