#!/usr/bin/env python3
import re

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

# The current regex on line 82 is: .replace([^a-z0-9\s]/g, '')
# We need: .replace(/[^a-z0-9\s]/g, '')
# Find the position and replace

# Find the regex text in the content
idx = content.find('[^a-z0-9')
if idx >= 0:
    print('Found at index:', idx)
    print('Context:', content[idx:idx+30])
    
    # Replace - the issue is the missing opening parenthesis
    # Current: .replace([^a-z0-9\s]/g, '')
    # Need: .replace(/[^a-z0-9\s]/g, '')
    
    # Get the text before and after
    before = content[:idx]
    after = content[idx:]
    
    # The broken line starts with .replace([ 
    # We need to change [^ to /[^
    new_content = before + '.replace(/[^a-z0-9\\s]/g, "")' + after.split('.replace([^a-z0-9')[1] if '.replace([^a-z0-9' in after else ''
    
    print('New content first 200:', new_content[:200])
    
    # Actually, let me just do a targeted replacement
    # The broken line is: .replace([^a-z0-9\s]/g, '')
    # We need: .replace(/[^a-z0-9\s]/g, '')
    
    # Replace the specific text
    old_text = '.replace([^a-z0-9'
    new_text = '.replace(/[^a-z0-9'
    
    if old_text in content:
        content = content.replace(old_text, new_text)
        print('Replaced regex text')
    else:
        print('Text not found')
    
    with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'w') as f:
        f.write(content)
    print('File written')
else:
    print('Could not find the regex text in content')