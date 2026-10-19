#!/usr/bin/env python3
with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'r') as f:
    lines = f.readlines()

# Line 255 (index 254) needs to be fixed - split assertion and rmSync onto separate lines
# Current: '  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n  rmSync(p + '.lock', { force: true })\\n'
# Need:  '  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))\\n' on line 254
#       '  rmSync(p + '.lock', { force: true })\\n' on line 255 (index 255)

# But looking at the current structure:
# Line 254 (index 253): assert.equal(second.acquired, false, ...)
# Line 255 (index 254): assertion + rmSync on same line (broken)
# Line 255 (index 255): writeFileSync

# We need to insert rmSync as a separate line after the assertion.
# The assertion is on line index 254, and rmSync needs to be on its own line.

# Find the assertion line and split it
idx = 254
current = lines[idx]
print('Current line', idx, ':', repr(current[:80]))

# The assertion part ends with '))' 
# Find where '))' is
idx_ending = current.find('))')
if idx_ending >= 0:
    # Take just the assertion part (up to and including '))')
    assertion_part = current[:idx_ending + 2]  # includes ))
    print('Assertion part:', repr(assertion_part))
    
    # The rest of the line has rmSync
    rest_part = current[idx_ending + 2:]
    print('Rest part:', repr(rest_part[:50]))
    
    # Now we need to:
    # 1. Replace line 254 (index 254) with just the assertion part + real newline
    # 2. Insert rmSync after it, before the current line 255 (index 255 which is writeFileSync)
    
    # Replace line 254 with assertion + actual newline
    actual_newline = '\n'
    lines[idx] = assertion_part + actual_newline
    print('Replaced line', idx, 'with:', repr(lines[idx]))
    
    # Now insert rmSync line after line 254 (index 254), pushing existing line 255 down
    # The rmSync text: '  rmSync(p + '.lock', { force: true })'
    rm_sync_line = '  rmSync(p + \'.lock\', { force: true })\n'
    
    # Insert at position idx + 1 (after the assertion line)
    lines.insert(idx + 1, rm_sync_line)
    print('Inserted rmSync line at position', idx + 1)
    
    # Now the old line that was at index 255 (writeFileSync) is now at index 256
    # That's fine, it just shifts down
    
    with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts', 'w') as f:
        f.writelines(lines)
    print('File repaired successfully')
else:
    print('Could not find )) in line')