# AIOS — development rules

How to work in this repository. Written so that a contributor who has never seen the project — and a
future session with no memory of it — can work without weakening anything by accident.

Read first: [`PROJECT-VISION.md`](PROJECT-VISION.md) ·
[`ARCHITECTURE.md`](architecture/ARCHITECTURE.md) · [`safety/GOVERNANCE-CONTRACT.md`](safety/GOVERNANCE-CONTRACT.md)

---

## 1. Hard rules

1. **`packages/control-core` is not modified.** It is inherited, proven code holding takeover, the
   latched stop and no-self-release. A change needs an ADR *and* a human decision.
2. **No invariant is weakened to make a metric better.** Record the conflict instead.
3. **Never push.** There is no remote, and adding one is a human decision.
4. **Never weaken the grammar into a validator.** `test_grammar_does_not_filter_semantics` exists to
   fail if you try. It is not a bug to fix.
5. **Do not fabricate a passing result.** No disabled test, no loosened assertion, no `&& true`.
6. **A partial run is never a pass.** Harnesses exit non-zero and say why.
7. **Measure before believing.** Every claim in this repo is a measurement with a reproduction
   command. A number that looks fine is not evidence until something underneath it is checked.

## 2. The defect class that actually occurs here

**Plausible-looking code that is wrong when executed. Not one of these was found by reading it.**

Real examples, all in this repo's history:

| Where | What looked right | What was true |
|---|---|---|
| M8 adversarial peer | read `body.request` | nothing sends that field, so every scenario got `root: undefined` |
| M8 dependency check | ids collected *while* iterating | the branch was unreachable; it reported "no such step" about a step in the array |
| M8 import-graph control | matched `ControlSurface` in its own **prose** | reported a leak that did not exist |
| M9 KV cache | wrote `past_0.key` | no input is named that, so the cache was silently never read back |
| M9 positions | read `cur.shape[1]` after reassignment | always advanced by 1 |
| M9 number validator | checked the sign after the digit test | rejected **every** negative number |
| M10 grammar `feed` | looked like a pure function | mutated its input, so speculative token trial corrupted shared state |
| M10 mission harness | printed a sample, then measured attempts | the sample ran **unconstrained** while the attempts ran constrained |
| M10 grammar key mask | followed the character machine | withheld the delimiters that end a number — the two halves disagreed |

**Consequence:** after writing code that decides something, *run the thing and look at the output*.
Then break it deliberately and confirm the check catches that.

## 3. Environment traps that have cost real time

Verified on this machine. Assume them until disproved.

- **Node type-stripping** (`--experimental-strip-types`) fails at **LOAD** time on:
  `constructor(private readonly x)` parameter properties; `require` in ESM; nested ternaries with a
  comment between `?` and the expression.
- **Operator precedence:** `!f in r` parses as `(!f) in r` — always false. Parenthesise.
- **Repository files are LF only.** A CRLF anchor in a regex silently matches nothing.
- **`Get-Process` has no `CommandLine`.** `Where-Object { $_.CommandLine -like '*server.py*' }` matches
  **nothing** and silently leaves a stale server holding the port. Use
  `Get-CimInstance Win32_Process -Filter "Name='python.exe'"`. This produced four servers all bound to
  8792 with the oldest answering — which is why an entire constrained run appeared to do nothing.
- **`io.open(p, "w")` truncates before it can fail.** A bad argument destroys the file and it is not in
  git. Never open a file for writing until the write is ready.
- **`Out-File` / `Set-Content` convert LF→CRLF.** Never measure a blob's line endings that way — use
  `git cat-file` via node.
- **`Set-Content -Value $array` collapses a multi-line array into one line.** Use
  `[IO.File]::WriteAllText` for bulk edits.
- **PowerShell 5.1** has no `PadEnd`; `$matches[1]` needs `${}`; `[IO.File]` resolves relative paths
  against the process CWD; regex bulk-rewrites of TypeScript imports mangle adjacent lines — verify
  after every bulk edit.
- **`execFile` cannot spawn `.cmd`/`.ps1` npm shims.**
- **WDAC enforces an Enterprise signing level** on this machine. Unsigned native binaries are refused.
  Microsoft-signed `onnxruntime` loads; `node-llama-cpp` did not. Do not attempt to circumvent — use a
  signed runtime or a separate process.
- **Live harnesses need the operator host:** `npm run control:up`, and ~30 s. `host.json` holds the
  live port and auth token; it is untracked and must stay that way.
- **The operator is not armed.** `mayInject=false`.

## 4. How to add a capability

1. Write the `PlanProposal` shape it needs — or add nothing and let the router refuse it.
2. Register a tool. A tool declares its **capability**, and `effectOf` classifies the **specific step**
   so `git status` and `git push` differ.
3. Register a **separate** verifier. A tool may not verify itself.
4. Declare the effect. Consequential effects require approval that is external to model output.
5. Add controls in **both** layers: a unit control and a live one. Then remove the protection and
   confirm each control **bites**.
6. Update `docs/ARCHITECTURE.md` and `EVIDENCE.md` with what you measured.

## 5. How to choose the next milestone

1. Prefer the **cheapest intervention that could change the binding constraint**.
2. Measure it in isolation. Report metrics **separately** — syntax / semantic / safety / usefulness are
   four different numbers and collapsing them is how a system looks better than it is.
3. Escalate only after the cheap options are measured and recorded.
4. If a milestone produced a negative result, **that is the finding**. Say so plainly.

## 6. Before you commit

```
npm test                                        # must be 0 failures
npm run control:audit-routes                    # must not exit 2. Exit 1 is a DOCUMENTED gap
                                                # (currently ADR 0003) and is the honest state.
python packages/model/local/test-grammar.py     # must be 90/90
git status --porcelain                          # must be clean
```

### About the route audit exit code

`0` the invariant holds. `1` it does **not** hold and every known cause is written down. `2` an
**undocumented breach** - a route changes the machine and nobody recorded why.

Exit 1 is currently correct and must not be "fixed" by touching `control-core` without a human
decision. Exit 2 is the alarm and must never be tolerated. Never silence either by adding a route to
`KNOWN_GAPS` - there is a control that fails if you try, because that is how a breach becomes permanent.

If `docs/` was not updated to match reality, the commit is incomplete. The repository, not the
conversation, is the source of truth.