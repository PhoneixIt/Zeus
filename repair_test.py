#!/usr/bin/env python3
# Repair the convergence.test.ts stale LOCK test line

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    lines = f.readlines()

# Line 255 (index 254) currently has both the assertion and rmSync on the same line
# which causes TypeScript parsing error. We need to separate them.

# The current state (from reading earlier):
# Line 254: '  assert.equal(second.holder, String(process.pid))\\n'  (but with our changes it's different)
# Line 255: '  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })\\n'

# What we need:
# Line 255: '  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n' (assertion only)
# Line 256: '  rmSync(p + '.lock', { force: true })\\n' (rmSync only)

# Let's check the actual content
line_255 = lines[254] if 254 < len(lines) else 'MISSING'
print('Line 255 (index 254) repr:', repr(line_255))

# We need to extract just the assertion part and put rmSync on its own line
# The assertion is: '  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n'
# The rmSync is: '  rmSync(p + '.lock', { force: true })\\n'

# Find the assertion text and rmSync text
assertion = '  assert.equal(second.holder, \'stale lock from pid ' + String(process.pid)\')'
rm_sync = '  rmSync(p + \'.lock\', { force: true })'

# Check if assertion is in the line
if assertion in line_255:
    # Extract just the assertion part up to the closing ))
    # The line has: assertion + \\n + rmSync part
    # We need to split them
    print('Assertion found in line 255')
else:
    print('Assertion not found, checking what\'s there...')
    # Just print what we have
    print('Full line:', line_255[:100])

# Now let's fix it: replace line 255 with just the assertion + newline,
# and ensure line 256 has rmSync
if 254 < len(lines):
    # Get just the assertion part - it ends with )) followed by \\n
    # Actually the line is: '  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })\\n'
    # We want: line 255: '  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n'
    # And line 256 should already have rmSync
    
    # Find where the assertion ends (at '))')
    idx_end = line_255.find('))') + 2  # include ))
    if idx_end > 2:
        # Take just the assertion part and add a real newline
        new_line_255 = line_255[:idx_end] + '\\n'
        # But we need an actual newline character, not the literal \\n
        # Let me use a different approach
        
        # Write the assertion line with actual newline
        actual_newline = '\n'
        lines[254] = line_255[:idx_end] + actual_newline
        
        # Now line 256 (index 255) should have rmSync - let's check and make sure it's correct
        if 255 < len(lines):
            line_256 = lines[255]
            print('Line 256 (index 255) repr:', repr(line_256))
            # Make sure rmSync is on its own line
            # It should start fresh
            print('Lines repair done')
        else:
            print('No line 256')
    else:
        print('Could not find )) in line 255')

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
    f.writelines(lines)
print('File written')