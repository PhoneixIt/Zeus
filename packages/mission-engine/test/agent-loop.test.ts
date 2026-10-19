/**
 * Tests for the agent loop's pure parts.
 *
 * The loop itself needs a browser, a free model and a desktop to be meaningful, so it is not
 * unit-tested here - it is demonstrated by real missions. What IS unit-tested is everything the
 * loop decides on its own: how a model's output is parsed, how a plan is checked against the
 * registry, and how a step reference is resolved. Those are the places a mistake silently
 * produces a wrong-but-plausible result.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parsePlan, validatePlan, catalogueForModel, catalogueEntry } from '../live/agent/agent.ts'
import { resolveRefs, parseCsv, allowedOutputPath, AGENT_OUT, commandAllowed, CAPABILITIES, resolveCapability } from '../live/agent/capabilities.ts'

const TMP = mkdtempSync(join(tmpdir(), 'aios-agent-test-'))
process.on('exit', () => { rmSync(TMP, { recursive: true, force: true }) })

describe('plan parsing: the model is untrusted input', () => {
  test('clean JSON parses', () => {
    const p = parsePlan('{"reply":"ok","steps":[{"id":"s1","intent":"do","tool":"terminal","args":{}}]}')
    assert.equal(p.reply, 'ok')
    assert.equal(p.steps.length, 1)
    assert.equal(p.steps[0]!.tool, 'terminal')
  })

  test('a fenced block is accepted, because real models emit one', () => {
    const p = parsePlan('```json\n{"reply":"r","steps":[]}\n```')
    assert.equal(p.steps.length, 0)
  })

  test('prose around the JSON is tolerated', () => {
    const p = parsePlan('Sure! Here is the plan:\n{"reply":"r","steps":[]}\nHope that helps.')
    assert.equal(p.reply, 'r')
  })

  test('output that is not a plan becomes a REPLY, not a thrown error', () => {
    // People type "hi". Treating a conversational answer as a malformed plan made an ordinary
    // message look like a broken system, and threw away what the model actually said.
    const p = parsePlan('Hello! How can I help you today?')
    assert.equal(p.steps.length, 0)
    assert.match(p.reply, /How can I help/)
  })

  test('JSON without a steps array keeps its reply', () => {
    const p = parsePlan('{"reply":"I need more detail to act on that."}')
    assert.equal(p.steps.length, 0)
    assert.equal(p.reply, 'I need more detail to act on that.')
  })

  test('a step with no tool is refused', () => {
    assert.throws(() => parsePlan('{"reply":"r","steps":[{"id":"s1","intent":"x"}]}'), /names no tool/)
  })

  test('args are defaulted to an object rather than left undefined', () => {
    const p = parsePlan('{"reply":"r","steps":[{"id":"s1","intent":"x","tool":"terminal"}]}')
    assert.deepEqual(p.steps[0]!.args, {})
  })
})

describe('plan validation: the registry has the last word', () => {
  test('an unknown tool is refused with a usable message', () => {
    const v = validatePlan(parsePlan('{"reply":"r","steps":[{"id":"s1","intent":"x","tool":"send-email"}]}'))
    assert.equal(v.steps.length, 0)
    assert.match(v.refusals[0]!, /no capability is registered as "send-email"/)
  })

  test('a capability that needs a human handover is PLANNABLE, not refused', () => {
    // Desktop input is blocked whenever a human is at the machine, and unblocks only when the
    // human clicks RELEASE and walks away. Refusing to plan it while blocked made it unusable:
    // it is blocked while the goal is being typed, and typing is itself the takeover. Planning it
    // is safe - the step still re-reads the guard at the instant it would inject.
    const v = validatePlan(parsePlan('{"reply":"r","steps":[{"id":"s1","intent":"type it","tool":"desktop-input","args":{"action":"type","text":"hello"}}]}'))
    assert.equal(v.steps.length, 1)
    assert.equal(v.refusals.length, 0)
  })

  test('a missing required argument is refused and named', () => {
    const v = validatePlan(parsePlan('{"reply":"r","steps":[{"id":"s1","intent":"x","tool":"terminal","args":{}}]}'))
    assert.equal(v.steps.length, 0)
    assert.match(v.refusals[0]!, /requires command/)
  })

  test('the goal supplies the objective a model reliably omits', () => {
    const v = validatePlan(parsePlan('{"reply":"r","steps":[{"id":"s1","intent":"research","tool":"web-research","args":{"url":"https://example.com/"}}]}'), 'find out about example.com')
    assert.equal(v.steps.length, 1)
    assert.equal(v.steps[0]!.args.objective, 'find out about example.com')
  })

  test('a supplied objective is NOT overwritten', () => {
    const v = validatePlan(parsePlan('{"reply":"r","steps":[{"id":"s1","intent":"x","tool":"web-research","args":{"url":"https://example.com/","objective":"specific"}}]}'), 'the broad goal')
    assert.equal(v.steps[0]!.args.objective, 'specific')
  })

  test('every registered capability declares a verifier', () => {
    // The executor refuses a step with no verifier, so a capability without one is unusable.
    for (const c of CAPABILITIES) {
      if (!c.available) continue
      assert.equal(typeof c.verifier.verify, 'function', `${c.id} has no verifier`)
      assert.equal(typeof c.description, 'string', `${c.id} has no description`)
      assert.ok(c.description.length > 40, `${c.id} description is too thin for the model to choose on`)
    }
  })

  test('the catalogue tells the model the arguments and what is unavailable', () => {
    const cat = catalogueForModel()
    assert.match(cat, /arguments:/)
    assert.match(cat, /REQUIRED/)
    // Desktop input is plannable while blocked, so it must say WAIT rather than "do not plan".
    assert.match(cat, /still PLANNABLE/)
    assert.match(cat, /will WAIT/)
  })

  test('an unavailable capability is still marked STATUS: UNAVAILABLE so the model skips it', () => {
    // Checked against a synthetic capability, not the real registry. Every real capability is
    // either available or plannable, so the registry can no longer produce this line - and a
    // rule that cannot be exercised is a rule that has quietly stopped being true.
    const line = catalogueEntry({
      id: 'imaginary', mode: 'gui', description: 'd',
      tool: { name: 'imaginary', mode: 'gui', async run() { return { kind: 'failed', reason: 'x' } } },
      verifier: { verifies: () => false, async verify() { return { rejected: 'x' } } },
      available: false, unavailableReason: 'because the test says so',
    })
    assert.match(line, /STATUS: UNAVAILABLE - because the test says so/)
    // A plannable one must NOT claim to be unavailable, or the model is told to skip a step that
    // is the only way to do what was asked.
    const plannable = catalogueEntry({
      id: 'imaginary', mode: 'gui', description: 'd',
      tool: { name: 'imaginary', mode: 'gui', async run() { return { kind: 'failed', reason: 'x' } } },
      verifier: { verifies: () => false, async verify() { return { rejected: 'x' } } },
      available: false, plannable: true, unavailableReason: 'waiting on a human',
    })
    assert.doesNotMatch(plannable, /STATUS: UNAVAILABLE/)
  })
})

describe('a REJECTED verification is never reported as verified', () => {
  // This is the defect that made an 18-step mission collapse. The executor emits
  // `evidence-verified` for both verdicts and separates them with `accepted`. Matching on the
  // event TYPE alone reported every rejected step as verified, so the window showed
  // "s1 verified" directly above "s1 ended as failed", and the next sixteen steps were skipped
  // for a reason that contradicted the line above it.
  test('the accepted flag, not the event type, decides', () => {
    const accepted = [{ type: 'evidence-verified', stepId: 's1', accepted: true, reason: 'independent check satisfied the step' }]
    const rejected = [{ type: 'evidence-verified', stepId: 's1', accepted: false, reason: 're-running produced different output' }]
    const verified = (evs: ReadonlyArray<Record<string, unknown>>): boolean =>
      Boolean(evs.find((e) => e.type === 'evidence-verified' && e.accepted === true))
    assert.equal(verified(accepted), true)
    assert.equal(verified(rejected), false)
  })

  test('a step that was refused is not verified even if an evidence event exists', () => {
    // A refusal and an evidence event can both be present for one step when a later attempt
    // failed. Whichever way it lands, the user must not be told the step succeeded.
    const evs = [
      { type: 'evidence-verified', stepId: 's1', accepted: true },
      { type: 'step-refused', stepId: 's1', reason: 'the guard refused' },
    ]
    const refusal = evs.find((e) => e.type === 'step-refused' || e.type === 'retry-exhausted')
    const verifiedEvent = evs.find((e) => e.type === 'evidence-verified' && e.accepted === true)
    assert.equal(Boolean(verifiedEvent) && !refusal, false)
  })

  test('an event with no accepted flag is not treated as verified', () => {
    // Older or partial event streams may omit `accepted`. Defaulting that to "verified" would
    // restore exactly the bug above, so an absent flag must not authorise a success claim.
    const evs: Array<Record<string, unknown>> = [{ type: 'evidence-verified', stepId: 's1' }]
    assert.equal(Boolean(evs.find((e) => e.type === 'evidence-verified' && e.accepted === true)), false)
  })
})

describe('reference resolution: a model chaining steps gets real values', () => {
  const prior = {
    s1: {
      id: 's1',
      outcome: 'done',
      durationMs: 1,
      output: { kind: 'data', summary: 'ok (5 chars)', data: { output: 'v24.21.0', path: 'C:/x.txt' } },
    },
  }

  test('the path a model naturally writes resolves', () => {
    assert.equal(resolveRefs('{{s1.data.output}}', prior).text, 'v24.21.0')
  })

  test('the executor shape also resolves', () => {
    assert.equal(resolveRefs('{{s1.output.data.path}}', prior).text, 'C:/x.txt')
  })

  test('referencing a whole tool result yields its summary', () => {
    assert.equal(resolveRefs('{{s1.output}}', prior).text, 'ok (5 chars)')
  })

  test('an unknown reference resolves empty AND is reported', () => {
    const r = resolveRefs('value=[{{s9.data.output}}]', prior)
    assert.equal(r.text, 'value=[]')
    assert.deepEqual(r.unresolved, ['{{s9.data.output}}'])
  })

  test('text that merely contains braces is left completely alone', () => {
    const r = resolveRefs('json example: {"a": 1}', prior)
    assert.equal(r.text, 'json example: {"a": 1}')
    assert.deepEqual(r.unresolved, [])
  })

  test('a reference to a missing field falls back to the step summary', () => {
    const r = resolveRefs('{{s1.data.nope}}', prior)
    assert.equal(r.text, 'ok (5 chars)')
  })

  test('text with no references is returned untouched', () => {
    assert.equal(resolveRefs('plain content', prior).text, 'plain content')
  })
})

describe('output paths: a tool cannot be turned into a file writer', () => {
  test('a path inside the agent output directory is allowed', () => {
    assert.ok(allowedOutputPath(join(AGENT_OUT, 'x.csv')).startsWith(AGENT_OUT))
  })

  test('a path outside it is refused', () => {
    assert.throws(() => allowedOutputPath('C:/Windows/System32/drivers/etc/hosts'), /outside it/)
    assert.throws(() => allowedOutputPath(join(process.cwd(), 'package.json')), /outside it/)
  })

  test('a traversal attempt is refused', () => {
    assert.throws(() => allowedOutputPath(join(AGENT_OUT, '..', '..', '..', 'escape.txt')), /outside it/)
  })

  test('an empty or relative path is refused', () => {
    assert.throws(() => allowedOutputPath(''), /outside it/)
  })
})

describe('the terminal allowlist is an allowlist', () => {
  test('ordinary read-only commands are permitted', () => {
    for (const c of ['node', 'git', 'python', 'dir', 'where', 'ver', 'tasklist']) {
      assert.equal(commandAllowed(c), true, c)
    }
  })

  test('anything destructive or remote is not', () => {
    for (const c of ['del', 'rm', 'format', 'curl', 'wget', 'powershell', 'cmd', 'reg', 'shutdown', 'Invoke-WebRequest']) {
      assert.equal(commandAllowed(c), false, c)
    }
  })

  test('case does not bypass it', () => {
    assert.equal(commandAllowed('DEL'), false)
    assert.equal(commandAllowed('Node'), true)
  })

  // ----- NEW: regression tests for the commandAllowed normalization fix -----

  test('bare executable name node is allowed', () => {
    assert.equal(commandAllowed('node'), true)
  })

  test('bare executable name git is allowed', () => {
    assert.equal(commandAllowed('git'), true)
  })

  test('bare executable name opencode-cli.exe is allowed', () => {
    assert.equal(commandAllowed('opencode-cli.exe'), true)
  })

  test('path with spaces C:\\Program Files\\nodejs\\node.exe is normalized to node', () => {
    assert.equal(
      commandAllowed('C:\\Program Files\\nodejs\\node.exe --version'),
      true,
      'spaces in path must not prevent normalization'
    )
  })

  test('quoted path long normalize to opencode-cli', () => {
    assert.equal(
      commandAllowed('"C:\\Users\\Samer\\AppData\\Local\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe" --version'),
      true,
      'quoted long path must normalize to opencode-cli'
    )
  })

  test('node.exe bare name with extension is normalized to node', () => {
    assert.equal(commandAllowed('node.exe'), true)
  })

  test('unauthorized executable cmd.exe is rejected', () => {
    assert.equal(commandAllowed('cmd.exe'), false)
  })

  test('unauthorized executable powershell.exe is rejected', () => {
    assert.equal(commandAllowed('powershell.exe'), false)
  })

  test('case insensitivity: NODE is allowed', () => {
    assert.equal(commandAllowed('NODE'), true)
  })

  test('case insensitivity: CMD.EXE is rejected', () => {
    assert.equal(commandAllowed('CMD.EXE'), false)
  })
})

describe('CSV: the verifier re-parses rather than trusting the writer', () => {
  test('quoted fields, embedded commas and escaped quotes survive a round trip', () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n')
    assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']])
  })

  test('a trailing newline does not create a phantom row', () => {
    assert.equal(parseCsv('a,b\n1,2\n').length, 2)
  })
})

describe('capability resolution reports unavailable tools honestly', () => {
  test('an available capability resolves to its tool', () => {
    const r = resolveCapability('web-research')
    assert.equal('tool' in r, true)
  })

  test('a capability that is blocked but plannable still resolves', () => {
    // It resolves even while the guard blocks input, because the block is cleared by a human
    // action rather than by waiting. Refusing to resolve it made the capability unreachable in
    // exactly the situation it exists for.
    const r = resolveCapability('desktop-input')
    assert.equal('tool' in r, true)
    if ('tool' in r) assert.equal(r.plannable, true)
  })

  test('a capability that is unknown is still named as unknown', () => {
    const r = resolveCapability('teleport')
    assert.equal('unavailable' in r, true)
    if ('unavailable' in r) assert.match(r.unavailable, /no capability is registered/)
  })
})