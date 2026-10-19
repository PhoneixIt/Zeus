with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    content = f.read()

# Replace the problematic line - the assertion has rmSync on the same line
old = "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })"
new = "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })"

# Actually the issue is the newline character. Let me just rewrite the test properly
# The original test had the assertion and rmSync on separate lines

# Find and replace the exact section
section_start = content.find("const p = join(DIR, 'r10.json')")
if section_start >= 0:
    # Find the stale lock test section
    stale_test_start = content.find("test('a stale LOCK from a dead process'", section_start)
    if stale_test_start >= 0:
        # Get the section from 'test(' to the next test or end
        section = content[stale_test_start:]
        # The issue: line 255 has assertion + rmSync on same logical line
        # Fix: ensure proper line break
        section_fixed = section.replace(
            "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })",
            "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })"
        )
        # Actually, let me just directly fix the line
        section_fixed = section.replace(
            "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })",
            "assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })"
        )
        print("Section:", section[:200])
        print("Fixed:", section_fixed[:200])

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.write(content)
print("Done - keeping original content")