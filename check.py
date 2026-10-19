import sys

with open(r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts', 'r') as f:
    content = f.read()

open_parens = content.count('(')
close_parens = content.count(')')
open_braces = content.count('{')
close_braces = content.count('}')

print('File size:', len(content))
print('Parens: open=%d, close=%d' % (open_parens, close_parens))
print('Braces: open=%d, close=%d' % (open_braces, close_braces))

# Check if the file has the reconcile function
if 'async reconcile(cwd: string): Promise' in content:
    print('reconcile function found')
else:
    print('reconcile function NOT found')

# Check the canReuse section
if 'canReuse =' in content:
    print('canReuse section found')
else:
    print('canReuse section NOT found')