p = r'C:\Users\Samer\Projects\AIOS\packages\agent\orchestrator.ts'
c = open(p, encoding='utf-8').read()

old = "import type { Reviewer, ReviewResult } from './reviewer.ts'"
new = old + "\n" + \
      "// Re-exported so a consumer of the orchestrator can type its reviewer without reaching past\n" + \
      "// this module into the reviewer implementation.\n" + \
      "export type { Reviewer, ReviewResult, ReviewVerdict } from './reviewer.ts'"

assert c.count(old) == 1, ('unexpected count', c.count(old))
c = c.replace(old, new)
open(p, 'w', encoding='utf-8').write(c)
print('added re-export')