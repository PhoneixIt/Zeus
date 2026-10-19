/**
 * GOVERNED BROWSER INTERACTION - click, fill, submit.
 * =============================================================================
 * WHAT THIS IS NOT
 * =============================================================================
 *
 * There is no `browser.eval`, and there never will be. A tool that ran JavaScript supplied by a step
 * would hand the page - or the step - the ability to do anything a browser can do, and the only way
 * to govern that afterwards is to guess. So the JavaScript in this file is FIXED and lives in the
 * TOOL, and a step may name a TARGET and nothing else.
 *
 * The rule that makes this governable is the same one the navigation policy already uses: the rules
 * are a CONSTRUCTOR argument, never a step argument. `NavigationPolicy` is supplied when the
 * registration is built, so a plan cannot widen it. The same is true here - `policy` and `browser`
 * arrive at registration time, and a step cannot reach them.
 *
 * =============================================================================
 * THREE CAPABILITIES, AND THE LINE BETWEEN THEM
 * =============================================================================
 *
 *   click   activate one element. Whatever the page's own handler does, happens.
 *   fill    put text into one field. Types data; transmits nothing by itself.
 *   submit  submit one form. THIS is the step that can send data away.
 *
 * They are separate capabilities, not one "interact" tool with a mode argument, because the
 * consequence differs. Filling a field is not the same act as submitting it, and a single tool with a
 * mode flag is a tool whose blast radius is whatever the most dangerous mode allows.
 *
 * =============================================================================
 * EVERY ACTION DECLARES AN EFFECT AND NEEDS APPROVAL
 * =============================================================================
 *
 * A click can trigger anything the page's handler does, including a request the page makes on the
 * user's behalf. So all three declare `external-send` - the closest kind available, and chosen over
 * inventing a new one. That choice is documented rather than hidden: a fill arguably transmits
 * nothing by itself, and calling it consequential is the conservative error. Over-approximating
 * costs a click; under-approximating costs a disclosure.
 *
 * THE TARGET BINDS MISSION, STEP, BROWSER AND PAGE. It is
 * `browser | selector | url-at-declaration`, so an approval granted for clicking `#submit` on this
 * page in this browser does not carry to another element, another browser, or the same element after
 * the page navigated. The executor binds mission, step, kind and target together, so the binding is
 * enforced by the existing gate rather than by this file hoping.
 *
 * =============================================================================
 * THE CLICK'S SUCCESS REPORT IS NOT EVIDENCE
 * =============================================================================
 *
 * `el.click()` returns void and this tool returns `{ kind: 'data' }`. That is a claim, and nothing in
 * this file treats it as proof. `interactionVerifier` re-observes the page afterwards and compares
 * the live DOM against an expectation the CONFIG supplies - never against what the tool said.
 */

/** The kind declared by all three. Named once so the reason cannot drift from the declaration. */
export const INTERACTION_EFFECT_KIND = 'external-send' as const

/**
 * The page handle an interaction acts on.
 *
 * Deliberately narrower than the full CDP `Page`: `url()` and `evaluate()` are the only things these
 * tools need, so depending on less means a fake can implement all of it and the governance logic can
 * be tested without launching a browser.
 */
export interface InteractionPage {
  /** The page's current URL. Synchronous, so `effectOf` can bind the effect to it. */
  url(): string
  /** Run `fn(arg)` in the page. The function is fixed by this file; `arg` is JSON-serialisable. */
  evaluate<TResult = unknown>(fn: (...args: never[]) => TResult | Promise<TResult>, arg?: unknown): Promise<TResult>
}

export interface InteractionDeps {
  readonly page: InteractionPage
  /**
   * THE POLICY. Supplied at registration time so a plan cannot widen it.
   *
   * The SAME policy object navigation uses, re-checked before every interaction. Without this a page
   * that redirected itself to a prohibited host could still be clicked, and the navigation
   * restriction would be a rule about typing a URL rather than about where the machine actually is.
   */
  readonly policy: NavigationPolicy
  /** Identifies WHICH browser. Part of the approval target, so approvals do not cross browsers. */
  readonly browser: string
}

import type { NavigationPolicy } from './navigation-policy.ts'
import { checkDestination } from './navigation-policy.ts'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { ToolRegistration } from '../../tool-router/router.ts'

// ============================================================================================
// IN-PAGE FUNCTIONS - fixed here, never supplied by a step
// ============================================================================================

/**
 * THE ONE IN-PAGE FUNCTION.
 *
 * It resolves AND acts in one body because CDP serialises the function with `toString()` and
 * evaluates that text inside the page. A function that calls a helper therefore fails at run time
 * with `ReferenceError: inPageResolve is not defined` - which is exactly what happened the first
 * time this was written as three small functions sharing one resolver, and which surfaced only in a
 * real browser. That is the worst place for a failure to appear.
 *
 * So the rule is: this function, `inPageProbe`, and `inPageAssert` must each be SELF-CONTAINED.
 * Anything they need, they define inside their own body. That is the transport, not a style choice.
 *
 * One function with a `kind`, rather than three with duplicated bodies: duplication would be three
 * chances for the refusal rules to drift apart, and a refusal that behaves differently for click and
 * for submit is a refusal nobody can rely on.
 */
type Resolution = { ok: true; tag?: string; id?: string | null; text?: string; value?: string; action?: string | null }
  | { ok: false; reason: string }

/**
 * THE ONE IN-PAGE FUNCTION.
 *
 * It resolves AND acts in one body because CDP serialises the function with `toString()` and
 * evaluates that text inside the page. Two consequences, both learned the hard way here:
 *
 *   - A function calling a module-scope helper fails at run time (`inPageResolve is not defined`).
 *   - A function CLOSING OVER a variable fails identically (`kind is not defined`), because the
 *     closure does not survive `toString()` either. So `kind` travels as DATA on the argument.
 *
 * Both compile here, and both pass every fake-page test, because a fake never serialises anything.
 * `IN_PAGE_SOURCE` below exists so a test can catch them without a browser.
 *
 * One function taking a `kind`, rather than three with duplicated bodies: duplication would be three
 * chances for the refusal rules to drift apart, and a refusal behaving differently for click and for
 * submit is a refusal nobody can rely on.
 */
function inPageAct(arg: { kind: 'click' | 'fill' | 'submit'; selector: string; value?: string }): Resolution {
  // EVERY in-page function takes ONE object argument. CDP calls `(fn)(literal)`, so a function taking
  // a bare `sel: string` receives the whole `{ selector, ... }` OBJECT instead and fails on
  // `querySelectorAll({...})`. `inPageAssert` did exactly that and only failed in a real browser -
  // the fake page passes a hand-built argument and so never noticed.
  //
  const sel = arg.selector
  let nodes: ArrayLike<Element>
  try {
    nodes = document.querySelectorAll(sel)
  } catch (e) {
    return { ok: false, reason: `the selector is not valid CSS: ${(e as Error)?.message ?? String(e)}` }
  }
  // THREE OUTCOMES, AND ALL THREE ARE REFUSALS.
  //
  // The ambiguous case is the one worth stating: a selector matching two buttons is an ambiguous
  // instruction, and acting on the first would be the machine quietly choosing which of two things a
  // person meant. There is no "pick the first" fallback anywhere in this file.
  if (nodes.length === 0) return { ok: false, reason: `no element on the page matches ${JSON.stringify(sel)}` }
  if (nodes.length > 1) {
    return { ok: false, reason: `the selector ${JSON.stringify(sel)} is AMBIGUOUS: it matches ${nodes.length} elements, so the intended target is not determined` }
  }
  const el = nodes[0] as HTMLElement
  const tag = el.tagName.toLowerCase()
  const id = el.id || null
  const text = (el.textContent ?? '').trim().slice(0, 120)

  if (arg.kind === 'click') {
    if ((el as HTMLButtonElement).disabled === true) return { ok: false, reason: 'the element is disabled' }
    el.scrollIntoView()
    // `click()` dispatches the activation a person's click would, so the page's own listener runs -
    // which is what makes the result meaningful rather than a synthetic no-op.
    el.click()
    return { ok: true, tag, id, text }
  }

  if (arg.kind === 'fill') {
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
      return { ok: false, reason: `${JSON.stringify(sel)} is a <${tag}>, which has no value to fill` }
    }
    const value = String(arg.value ?? '')
    el.focus()
    // Assign through the NATIVE setter where one exists, so a listener sees the same transition a
    // person's keystrokes produce. Assigning the property directly can leave a shadowed value in
    // place - a subtle way to report a fill that did not happen.
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype
      : tag === 'select' ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else (el as HTMLInputElement).value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag, id, text, value: (el as HTMLInputElement).value }
  }

  if (tag !== 'form') return { ok: false, reason: `${JSON.stringify(sel)} is a <${tag}>, not a <form>, so it cannot be submitted` }
  // `requestSubmit` runs constraint validation and fires the submit event, so a page that refuses to
  // submit refuses HERE - rather than the tool reporting a submission that never occurred.
  if (typeof (el as HTMLFormElement).requestSubmit === 'function') (el as HTMLFormElement).requestSubmit()
  else el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return { ok: true, tag: 'form', id, text, action: el.getAttribute('action') }
}


/** The world the action is taken against. Self-contained for the same transport reason. */
function inPageProbe(): { ready: boolean; url: string; title: string } {
  return { ready: document.readyState === 'complete', url: location.href, title: document.title }
}

// ============================================================================================
// THE BINDING
// ============================================================================================

/**
 * What an approval is bound to.
 *
 * Exact rather than truncated: a truncated URL could collide, and a collision would let an approval
 * for one page authorise an action on a different one. The string is long; that is the correct price.
 */
export function interactionTarget(deps: InteractionDeps, sel: string): string {
  return `${deps.browser}|${sel}|${deps.page.url()}`
}

const selectorOf = (step: { args?: Record<string, unknown> }): { ok: true; sel: string } | { ok: false; reason: string } => {
  const sel = (step.args as { selector?: unknown } | undefined)?.selector
  if (typeof sel !== 'string' || !sel.trim()) {
    return { ok: false, reason: 'no selector was given. A step names a TARGET; it cannot supply code or a URL.' }
  }
  // Control characters have no meaning in a selector and have been used to smuggle one past a
  // reviewer. Refused rather than trimmed, so what was typed is what is judged.
  if (/[\u0000-\u001f\u007f]/.test(sel)) return { ok: false, reason: 'the selector contains control characters' }
  return { ok: true, sel: sel.trim() }
}

/**
 * The gate that runs BEFORE authorisation, for every one of the three tools.
 *
 * SYNCHRONOUS, because the router's `preflight` hook is synchronous. That is a real constraint rather
 * than an accident, and it shapes what belongs here: everything decidable from the step and the
 * browser's own current URL. The checks that need the DOM - is the page still loading, does the
 * selector still resolve to one element - happen in the TOOL, immediately before the action, where
 * they can be awaited and where being one moment later is the safer order anyway.
 *
 * Order matters and matches navigation: the destination policy is evaluated FIRST, because a page at
 * a prohibited address is not an action awaiting a signature - it is an action the system will not
 * take at all, and reporting it as `needs-human` would imply a human could approve it.
 */
function interactionPreflight(deps: InteractionDeps, tool: string) {
  return (step: { id: string; args?: Record<string, unknown> }):
  | { blocked: string; needsHuman: boolean }
  | undefined => {
    const sel = selectorOf(step)
    if (!sel.ok) return { blocked: `${tool} refused: ${sel.reason}`, needsHuman: false }

    // GATE 1 - where the machine ACTUALLY is, not where the step says it is.
    const here = checkDestination(deps.page.url(), deps.policy)
    if (!here.ok) {
      return { blocked: `${tool} refused: the page is at a destination this policy forbids: ${here.reason}`, needsHuman: false }
    }
    return undefined
  }
}

/** The effect declaration. Present for every permitted action, so the approval gate always engages. */
function interactionEffect(deps: InteractionDeps, verb: string) {
  return (step: { args?: Record<string, unknown> }):
  | { kind: typeof INTERACTION_EFFECT_KIND; target: string; reason: string; irreversible: boolean }
  | undefined => {
    const sel = selectorOf(step)
    if (!sel.ok) return undefined
    // A destination the policy forbids declares NO effect, because preflight has already blocked it.
    const here = checkDestination(deps.page.url(), deps.policy)
    if (!here.ok) return undefined
    return {
      kind: INTERACTION_EFFECT_KIND,
      target: interactionTarget(deps, sel.sel),
      reason: `${verb} ${sel.sel} on ${deps.page.url().slice(0, 80)} in browser ${deps.browser}`,
      irreversible: false,
    }
  }
}

/**
 * The shared body of all three tools.
 *
 * Re-checking the gate here is not redundancy. The executor runs preflight before tool selection, but
 * a tool that trusts its own preflight has already lost - so the page's URL and readiness are read
 * again immediately before the action, and the resolved element is re-checked for ambiguity.
 */
function makeInteractionTool(
  deps: InteractionDeps,
  toolName: string,
  verb: string,
  kind: 'click' | 'fill' | 'submit',
) {
  return {
    name: toolName,
    mode: 'browser' as const,
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const sel = selectorOf({ args })
      if (!sel.ok) return { kind: 'failed', reason: sel.reason }

      // The policy, again, at the moment of action.
      const here = checkDestination(deps.page.url(), deps.policy)
      if (!here.ok) return { kind: 'failed', reason: `refused: the page is now at ${deps.page.url()}, which this policy forbids: ${here.reason}` }

      // STALENESS. The page must be SETTLED, and must not have moved since the gate read it. Acting
      // into a document that is still loading is how a click lands on a page that has not finished
      // arriving - and an approval granted for one page must not be spent on the page that replaced it
      // a moment later. Both checks live here rather than in preflight because this hook can await and
      // the router's cannot.
      const expectedUrl = deps.page.url()
      let probe: { ready: boolean; url: string }
      try {
        probe = await deps.page.evaluate<{ ready: boolean; url: string }>(inPageProbe as never)
      } catch (e) {
        return { kind: 'failed', reason: `refused: the page could not be read (${(e as Error)?.message ?? String(e)})` }
      }
      if (!probe.ready) {
        return { kind: 'failed', reason: `refused: the page is still loading, so ${sel.sel} is not yet determinate` }
      }
      if (probe.url !== expectedUrl) {
        return { kind: 'failed', reason: `refused: the page moved from ${expectedUrl} to ${probe.url}, so the approval for the earlier page does not apply here` }
      }

      let resolution: Resolution
      try {
        resolution = (await deps.page.evaluate(inPageAct as never, { kind, selector: sel.sel, value: String(args.value ?? '') })) as Resolution
      } catch (e) {
        return { kind: 'failed', reason: `the page refused to run the ${verb}: ${(e as Error)?.message ?? String(e)}` }
      }
      if (!resolution.ok) return { kind: 'failed', reason: resolution.reason }

      // Reported as a CLAIM. The verifier re-observes the page; this is not evidence of anything.
      return {
        kind: 'data',
        data: {
          selector: sel.sel,
          tag: resolution.tag ?? null,
          id: resolution.id ?? null,
          text: resolution.text ?? null,
          value: resolution.value ?? null,
          browser: deps.browser,
          url: deps.page.url(),
        },
        summary: `${verb} ${sel.sel} (${resolution.tag ?? 'element'})`,
      }
    },
  } satisfies Tool
}

/**
 * The serialised source of every function that runs inside the page.
 *
 * Exported for exactly one reason: a test can assert each is SELF-CONTAINED. CDP evaluates
 * `fn.toString()`, so an in-page function that references a module-scope helper - or a closure
 * variable, or another in-page function - compiles here, passes every fake-page test, and then fails
 * with `ReferenceError` in a real browser. That happened three times while writing this file.
 *
 * A fake page cannot catch it, because a fake never serialises anything. This export makes the
 * failure mode testable without one.
 */
export const IN_PAGE_SOURCE: Readonly<Record<string, string>> = {
  act: String(inPageAct),
  probe: String(inPageProbe),
  assert: String(inPageAssert),
}

export function interactionRegistration(deps: InteractionDeps): ToolRegistration[] {
  const tools = [
    makeInteractionTool(deps, 'click-element', 'clicked', 'click'),
    makeInteractionTool(deps, 'fill-field', 'filled', 'fill'),
    makeInteractionTool(deps, 'submit-form', 'submitted', 'submit'),
  ]
  return tools.map((tool, i) => ({
    tool,
    capabilities: [['browser.click', 'browser.fill', 'browser.submit'][i]!],
    preflight: interactionPreflight(deps, tool.name),
    effectOf: interactionEffect(deps, ['click', 'set the value of', 'submit'][i]!),
  }))
}

// ============================================================================================
// INDEPENDENT VERIFICATION - re-observe, never re-read the tool
// ============================================================================================

/** What the CONFIG requires the page to look like afterwards. */
export interface PageExpectation {
  /** An element that must exist. */
  selector?: string
  /** Text the element must contain. For an `<input>` this is always empty - see `value`. */
  text?: string
  /** The element's `value` property must contain this. The only way to check a filled field. */
  value?: string
  /** The page's URL must equal this. */
  url?: string
  /** The selector must match exactly this many elements - which is how a DISAPPEARANCE is checked. */
  count?: number
}

export interface InteractionVerifierDeps {
  readonly page: InteractionPage
  readonly policy: NavigationPolicy
  /**
   * What each step requires. Supplied by the CONFIG.
   *
   * Not by the step. An expectation written by the step is the step grading its own homework, and a
   * step that clicks a button and then asserts the button did nothing would verify successfully.
   */
  readonly expect: (step: { id: string }) => PageExpectation | undefined
}

/**
 * One round trip, reading the live DOM.
 *
 * Returns the selector's matches and its count together, because two different controls need two
 * different shapes of evidence: an APPEARANCE needs the text, and a DISAPPEARANCE - a button that
 * vanished after the click, an error that cleared - needs the count. Checking only the text would let
 * a page that showed the expected message while leaving the error banner up pass.
 *
 * `text` and `url` are passed but unused here on purpose: the comparison happens in Node, against
 * what the CONFIG said, so there is no in-page code that could agree with itself.
 */
function inPageAssert(arg: { selector: string | null }) {
  const sel = arg.selector
  const nodes = sel === null ? [] : Array.from(document.querySelectorAll(sel))
  return {
    url: location.href,
    ready: document.readyState,
    matches: nodes.map((el) => (el.textContent ?? '').trim()),
    // The `value` PROPERTY, separately. An `<input>` has no textContent at all - what a person typed
    // is a property - so verifying a form fill against text can only ever see an empty string. Reading
    // only textContent was why the first fill step verified as an empty match.
    values: nodes.map((el) => {
      const v = (el as HTMLInputElement).value
      return typeof v === 'string' ? v : ''
    }),
    count: sel === null ? -1 : nodes.length,
  }
}

export function interactionVerifier(deps: InteractionVerifierDeps): Verifier {
  return {
    verifies: (step) => step.tool === 'click-element' || step.tool === 'fill-field' || step.tool === 'submit-form',

    async verify(step, _ctx, _data) {
      const want = deps.expect(step)
      if (!want || (!want.selector && !want.url && want.count === undefined)) {
        // The same refusal the terminal verifier makes, for the same reason: a step with no
        // expectation cannot be verified, and calling it verified is the exit-code-0 mistake.
        return { rejected: `step "${step.id}" declares no verifiable expectation, so the ${step.tool} cannot be claimed complete` }
      }

      // The page must still be somewhere the policy permits. A page that redirected itself after the
      // click must not be read as a success.
      const here = checkDestination(deps.page.url(), deps.policy)
      if (!here.ok) return { rejected: `refused to verify: the page is now at a forbidden destination (${here.reason})` }

      let observed: { url: string; ready: string; matches: string[]; values: string[]; count: number }
      try {
        observed = (await deps.page.evaluate(inPageAssert as never, {
          selector: want.selector ?? null,
        })) as typeof observed
      } catch (e) {
        return { rejected: `the page could not be re-observed: ${(e as Error)?.message ?? String(e)}` }
      }

      if (observed.url !== deps.page.url()) {
        return { rejected: `the page moved during the action: ${deps.page.url()} -> ${observed.url}` }
      }
      if (want.url !== undefined && observed.url !== want.url) {
        return { rejected: `the page is at ${observed.url}, not the required ${want.url}` }
      }
      if (want.count !== undefined && observed.count !== want.count) {
        return { rejected: `expected ${want.count} element(s) matching ${JSON.stringify(want.selector ?? '*')}, but the live page has ${observed.count}` }
      }
      if (want.value !== undefined) {
        const joinedValues = observed.values.join('\n')
        if (!joinedValues.includes(want.value)) {
          return {
            rejected: `the field does not contain ${JSON.stringify(want.value)}: it currently holds ` +
              `${JSON.stringify(joinedValues.slice(0, 160))}. A tool reporting a fill is not evidence ` +
              `that the field was written, and an input has no text content to read.`,
          }
        }
      }
      if (want.text !== undefined) {
        const joined = observed.matches.join('\n')
        if (!joined.includes(want.text)) {
          return {
            rejected: `the page does not contain ${JSON.stringify(want.text)}: it currently reads ` +
              `${JSON.stringify(joined.slice(0, 160))}. A tool reporting a click is not evidence that the page changed.`,
          }
        }
      }
      return { evidence: { kind: 'interaction-verified', selector: want.selector ?? null, url: observed.url, matched: observed.matches.length } as never }
    },
  }
}
