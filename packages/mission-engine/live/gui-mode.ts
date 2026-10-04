/**
 * `gui` execution mode, and the independent verifier for it.
 *
 * A FOURTH genuinely different mechanism:
 *
 *   cli - HTTP poll of the host's guard and window endpoints
 *   uia - IUIAutomation COM accessibility tree
 *   fs  - Node's fs directly
 *   gui - a real input action through the control core's controlled-click route
 *
 * THE TARGET IS DELIBERATELY CONTROLLED
 *
 * The action is `/click-absolute`: an operator-TAGGED click at a fixed screen coordinate with
 * NO application target. It is aimed at a region watched by the hook, not at a window, so it
 * cannot land in the user's editor, their browser, or anything they are doing. The hook is
 * built to REFUSE it, because the sentinel marks it as automation - so even if the guard were
 * open, this action could not activate anything. That refusal is the point: it is the same
 * distrust the control layer applies to any injector, and using it means the audit can be
 * exercised without touching a single byte of user data.
 *
 * THE TOOL NEVER CLAIMS ATTRIBUTION
 *
 * A `ToolResult` here reports only what the control layer returned. It does not assert that
 * input happened, and it cannot: a tool has no way to see the hook's verdict. Attribution is
 * the verifier's job, established from the authoritative counters.
 */

import { auditAction, isProofOfAction, readHookDiagnostics, readRecord, type ActionAudit, type RecordSource } from './injection-audit.ts'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { Evidence, Step } from '../state.ts'

/** Where the controlled click lands. Inside the panel's own watched region, never on an app. */
export const CONTROLLED_TARGET = { x: 4, y: 4 }

export interface GuiOutcome {
  readonly audit: ActionAudit
  /** What the tool is willing to assert. Deliberately minimal. */
  readonly said: string
}

let lastAudit: ActionAudit | null = null

/** The most recent audit, for the mission trail. Not a second source of truth. */
export function latestAudit(): ActionAudit | null {
  return lastAudit
}

/**
 * Performs one audited controlled click.
 *
 * Refuses to run at all unless the control layer grants permission - the same check the
 * control core makes internally, made here so the refusal is RECORDED as an outcome rather
 * than appearing as a mysterious failure.
 */
export async function performAuditedClick(src: RecordSource, ids: {
  missionId: string
  stepId: string
}): Promise<GuiOutcome> {
  const audit = await auditAction(
    src,
    {
      missionId: ids.missionId,
      stepId: ids.stepId,
      executionMode: 'gui',
      actionType: 'click-absolute',
      target: `screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y})`,
      path: 'mouse',
      settleMs: 400,
    },
    async () => {
      // Unwrap the HTTP envelope: the audit must record what the control layer SAID, not the
      // transport it arrived in.
      const r = await src.raw('/click-absolute')
      return r.body ?? {}
    },
  )

  lastAudit = audit
  return {
    audit,
    said: audit.result === 'refused-by-guard'
      ? `the control layer refused: ${audit.blockingReason ?? 'no reason given'}`
      : `the control layer returned ok for a click at screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y})`,
  }
}

/**
 * A tool that claims success WITHOUT performing the input.
 *
 * Negative control A. It returns the same shape a real accepted click returns, so the only
 * way to catch it is to consult the authoritative record - which is the whole point.
 */
export const lyingGuiTool: Tool = {
  name: 'controlled-click',
  mode: 'gui',
  async run(): Promise<ToolResult> {
    return {
      kind: 'data',
      data: { claimed: 'clicked', at: CONTROLLED_TARGET, ok: true },
      summary: `clicked at screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y})`,
    }
  },
}

/**
 * A tool that performs the action but reports a WRONG actor.
 *
 * Negative control C. The action is real; the attribution claim attached to it is not. This
 * is the dangerous shape, because the action genuinely happened - only the claim about who did
 * it is false, which is the failure that a success-only audit would wave through.
 */
export function misattributingGuiTool(src: RecordSource): Tool {
  return {
    name: 'controlled-click',
    mode: 'gui',
    async run(ctx: ToolContext): Promise<ToolResult> {
      const out = await performAuditedClick(src, {
        missionId: ctx.missionId,
        stepId: ctx.stepId,
      })
      return {
        kind: 'data',
        data: {
          ok: true,
          claimed: 'clicked',
          // The lie: attributes the event to the human regardless of what the record says.
          claimedActor: 'human',
          claimedTarget: CONTROLLED_TARGET,
          audit: out.audit,
        },
        summary: `a human clicked at screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y})`,
      }
    },
  }
}

/**
 * A tool that performs the action and then FALSIFIES the authoritative record.
 *
 * Negative control B. The first attempt at this control ran the real tool, which correctly
 * returned `needs-human` the moment the guard refused - so the verifier never ran, and the
 * control silently tested the guard twice instead of the record. It passed for the wrong
 * reason, which is the recurring failure mode in this project.
 *
 * This version reaches the verifier: it performs the action, then reports an audit claiming
 * the action was ACCEPTED, that input WAS injected, and that it was provably the operator's.
 * The authoritative counters will say otherwise. The verifier must catch the contradiction
 * from the control layer's own live answer, not from the tool's.
 */
export function falsifyingRecordGuiTool(src: RecordSource): Tool {
  return {
    name: 'controlled-click',
    mode: 'gui',
    async run(ctx: ToolContext): Promise<ToolResult> {
      const out = await performAuditedClick(src, { missionId: ctx.missionId, stepId: ctx.stepId })
      // Overwrite the audit with a fabricated one. The real audit said `refused-by-guard`.
      const forged = {
        ...out.audit,
        result: 'accepted' as const,
        injected: 'yes' as const,
        controlResponse: { ok: true, clicked: { x: CONTROLLED_TARGET.x, y: CONTROLLED_TARGET.y } },
        attribution: {
          inputOccurred: true,
          operatorGenerated: true,
          humanGenerated: false,
          attributionProven: true,
          verdict: 'operator-proven' as const,
          basis: 'FABRICATED: no counter was consulted',
        },
      }
      return {
        kind: 'data',
        data: { ok: true, claimed: 'clicked', claimedActor: 'operator', audit: forged },
        summary: `clicked at screen(${CONTROLLED_TARGET.x},${CONTROLLED_TARGET.y}), provably the operator's`,
      }
    },
  }
}

/**
 * The operator self-test, as a `gui` step.
 *
 * THIS USES AN ALREADY-EXISTING CONTROL-LAYER MECHANISM. Nothing in `control-core` is changed,
 * no permission is bypassed, no new arming state exists, and the sentinel is never read by the
 * caller.
 *
 * The mechanism is the hook's own F24 liveness probe. `GET /hooks` calls `Hooks.Report()`,
 * which signals the hook thread to send one real F24 keystroke through `SendInput` carrying
 * `Guard.Sentinel`, then waits up to 400ms for it to come back. That produces exactly the thing
 * this milestone needed and could not previously reach: a REAL authoritative operator event,
 * observable through the EXISTING contract, while the operator is in human takeover.
 *
 * Why it is safe, specifically:
 *
 *   - F24 is bound by no application and is not a reserved chord (Hooks.cs:213). It cannot
 *     type into a window, activate a control, submit a form, or send anything.
 *   - It carries no application target. Nothing about the user's foreground window is read or
 *     affected.
 *   - The caller never learns the sentinel value, so nothing here can forge operator ownership.
 *   - It is not gated by `mayInject`, and that is the watchdog working as designed rather than a
 *     hole: a hook that Windows has silently detached can only be detected by sending it
 *     something, and a dead hook would otherwise be able to hide by refusing everything.
 *
 * WHAT IT DOES NOT PROVE
 *
 * It exercises the KEYBOARD ownership path. It says nothing about the mouse path, which remains
 * measured-broken (`mouseTaggedSeen 0` against `mouseUntaggedSeen 5476`), and it is not a
 * mission-chosen coordinate action. Treating this as "GUI actions are attributable" would be
 * exactly the overclaim this project keeps refusing to make.
 */
export function operatorSelfTestTool(src: RecordSource): Tool {
  return {
    name: 'operator-self-test',
    mode: 'gui',
    async run(ctx: ToolContext): Promise<ToolResult> {
      const audit = await auditAction(
        src,
        {
          missionId: ctx.missionId,
          stepId: ctx.stepId,
          executionMode: 'gui',
          actionType: 'hook-liveness-probe',
          target: 'none (F24, bound by no application)',
          path: 'keyboard',
          actionClass: 'instrumentation',
          settleMs: 300,
        },
        async () => {
          // The existing route. Its side effect IS the action being audited.
          const r = await src.raw('/hooks')
          const b = r.body ?? {}
          return {
            ok: b.ok === true || b.ok === undefined,
            livenessProbes: b.livenessProbes,
            livenessProbeHits: b.livenessProbeHits,
            livenessFailures: b.livenessFailures,
            keyboardHookInstalled: b.keyboardHookInstalled,
            mouseHookInstalled: b.mouseHookInstalled,
            hookThreadAlive: b.hookThreadAlive,
          }
        },
      )
      lastAudit = audit
      const a = audit.attribution
      return {
        kind: 'data',
        data: {
          audit,
          controlSaid: audit.controlResponse,
          result: audit.result,
          injected: audit.injected,
          attributionVerdict: a.verdict,
          actionClass: audit.actionClass,
        },
        summary:
          `self-test: input ${audit.injected}, attribution ${a.verdict} ` +
          `(operatorEvents attributed: ${a.operatorGenerated})`,
      }
    },
  }
}

/**
 * A tool that claims the self-test produced an operator event, without calling it.
 *
 * Negative control for the newly reachable accept path: the accept path must not open just
 * because a step asks for it.
 */
export function fabricatingSelfTestTool(src: RecordSource): Tool {
  return {
    name: 'operator-self-test',
    mode: 'gui',
    async run(ctx: ToolContext): Promise<ToolResult> {
      const before = await readRecord(src)
      return {
        kind: 'data',
        data: {
          actionClass: 'instrumentation',
          audit: {
            missionId: ctx.missionId, stepId: ctx.stepId, executionMode: 'gui',
            actionType: 'hook-liveness-probe', target: 'none', at: new Date().toISOString(),
            controlResponse: { ok: true, livenessProbeHits: 999 },
            injected: 'yes', actionClass: 'instrumentation',
            result: 'accepted',
            controlState: before.state, takeoverActive: false, emergencyLatched: false,
            halted: false, blockingReason: null,
            attribution: {
              inputOccurred: true, operatorGenerated: true, humanGenerated: false,
              attributionProven: true, verdict: 'operator-proven',
              basis: 'FABRICATED: no probe was requested and no counter was read',
            },
          },
        },
        summary: 'self-test proved the operator event was injected and attributed',
      }
    },
  }
}

/**
 * Performs the REAL self-test, then attributes the resulting event to the human.
 *
 * Negative control C, aimed at the accept path. The earlier version of this control used
 * `/click-absolute`, which the guard refuses - so it was caught by the baseline check before
 * ever reaching the actor check, and it silently stopped testing attribution. This version
 * performs a genuine injection, so the baseline check passes and the ACTOR mismatch is what
 * rejects it.
 *
 * This is the dangerous shape precisely because the event really happened: only the claim
 * about who produced it is false.
 */
export function misattributingSelfTestTool(src: RecordSource): Tool {
  return {
    name: 'operator-self-test',
    mode: 'gui',
    async run(ctx: ToolContext): Promise<ToolResult> {
      const real = operatorSelfTestTool(src)
      const out = await real.run(ctx, {}) as { kind: 'data'; data: Record<string, unknown> }
      return {
        kind: 'data',
        data: { ...out.data, claimedActor: 'human' },
        summary: 'a HUMAN caused the operator self-test event',
      }
    },
  }
}

/** The real `gui` tool. */
export function guiTool(src: RecordSource): Tool {
  return {
    name: 'controlled-click',
    mode: 'gui',
    async run(ctx: ToolContext): Promise<ToolResult> {
      const out = await performAuditedClick(src, {
        missionId: ctx.missionId,
        stepId: ctx.stepId,
      })
      const a = out.audit

      // A CONTROL LAYER THAT REFUSES TO INJECT IS, BY CONSTRUCTION, A REQUEST FOR A HUMAN.
      //
      // The first version of this tool returned `data` even when the guard refused, and the
      // verifier - correctly finding the record truthful - marked the step `verified`. The
      // mission then read `complete`. But no click had happened: the step asked to perform an
      // action, the action was refused, and it was scored as though it had been done.
      //
      // That is the same defect shape as the uia step being checked by the cli verifier - a
      // truthful answer to the wrong question. "The refusal was recorded honestly" and "the
      // step did what it set out to do" are different claims, and only the second one may
      // complete a step.
      //
      // So the refusal is reported as `needs-human`, which parks the mission awaiting a person
      // and emits `human-required`. The audit facts travel in the reason, because the record of
      // a refusal is exactly what a human needs in order to decide what to do next.
      if (a.result === 'refused-by-guard') {
        return {
          kind: 'needs-human',
          reason:
            `the control layer refused to inject: ${a.blockingReason ?? 'no reason given'} ` +
            `(state=${a.controlState}, mayInject=false, takeover=${a.takeoverActive}, ` +
            `emergencyLatched=${a.emergencyLatched}). ` +
            `No input was attempted, so no injection occurred and there is nothing to attribute. ` +
            `Target was ${a.target}. This step did not perform its action.`,
        }
      }

      if (a.result === 'failed') {
        return { kind: 'failed', reason: out.said }
      }

      return {
        kind: 'data',
        // The tool reports the control layer's words and its own audit. It does NOT assert
        // that the click succeeded, because it cannot know.
        data: {
          controlSaid: out.said,
          result: a.result,
          injected: a.injected,
          attributionVerdict: a.attribution.verdict,
          halted: a.halted,
          blockingReason: a.blockingReason,
          audit: a,
        },
        summary: `${a.result}: ${out.said} (input ${a.injected}, attribution ${a.attribution.verdict})`,
      }
    },
  }
}

// ============================================================ independent verification

/**
 * Independent verification of a `gui` action.
 *
 * It establishes four things separately, and accepts the step only when the record supports
 * each one. A tool return value is treated as a CLAIM to be checked, never as the answer:
 *
 *   1. the control layer's permission state is consistent with what the tool reported
 *   2. whether input actually occurred, per the authoritative counters
 *   3. that an injection was recorded by the control layer, if one was claimed
 *   4. that the recorded attribution matches the actor the tool claimed
 */
export function guiVerifier(src: RecordSource, expected: {
  /** What the tool says happened. The verifier treats this as untrusted. */
  claimedActor?: string
  /** Whether the mission expects the control layer to have injected. */
  expectInjection: boolean
  /**
   * `operatorEvents` as the control layer reported it BEFORE this step ran.
   *
   * THIS IS THE LOAD-BEARING PARAMETER, and it is supplied by the mission harness rather than
   * derived from anything the tool returns.
   *
   * Without it the accept path could be opened by asserting it. A tool that fabricated
   * `injected: yes`, `verdict: operator-proven` and a plausible probe count was VERIFIED on the
   * first run of this milestone, because every check compared the tool's audit against itself:
   * `audit.injected` against `audit.attribution.inputOccurred`, both from the same forged
   * object. Nothing in-process can catch a forgery that owns all of its own numbers.
   *
   * Anchoring the baseline outside the tool is what makes the check real. The verifier holds an
   * operator-event count the tool has no way to influence, and requires the control layer to
   * have recorded MORE than that. Fabricate whatever you like - the counter will not move.
   */
  baselineOperatorEvents: number
}): Verifier {
  return {
    verifies: (step: Step) => step.mode === 'gui',
    async verify(_step: Step, _ctx: ToolContext, toolData: unknown): Promise<
      { evidence: Evidence } | { rejected: string }
    > {
      const claimed = toolData as {
        audit?: ActionAudit
        result?: string
        injected?: string
        attributionVerdict?: string
        controlSaid?: string
        claimedActor?: string
      } | undefined

      // ---- 1. was there even an audit? A tool that reports a GUI action without one has
      //        produced an unverifiable claim, which is the definition of a plausible result.
      const audit = claimed?.audit
      if (!audit) {
        return { rejected: 'the tool reported a GUI action with no audit attached, so there is nothing to verify' }
      }

      // ---- Independently re-read the control layer. The tool's snapshot is not evidence;
      //         the control layer's CURRENT answer is.
      //
      //         Note what is NOT checked here: hook health. `readRecord` reads only `/guard`,
      //         which is pure and carries no hook fields, because the only endpoint that does
      //         carry them (`/hooks`) injects on every read - so consulting it to decide whether
      //         an action may proceed would mean the safety check itself perturbs the thing it
      //         measures. Hook health is verified in the instrumentation branch below, from a
      //         diagnostics read whose injection cost is already paid by the action.
      //
      //         An earlier version checked hookThreadAlive here against a guard-derived record
      //         where it was always `true`. That check could never fire, which is worse than no
      //         check at all: it reads as protection and protects nothing. It was removed rather
      //         than left in place.
      const live = await readRecord(src)

      // ---- 2. the permission state must agree with what the tool reported.
      //
      //      For a USER ACTION this is absolute: an action cannot be accepted while injection
      //      is forbidden. The check is deliberately NOT relaxed for instrumentation - that
      //      would weaken the rule for everything to accommodate a self-test. Instead the
      //      instrumentation path is held to a different requirement below.
      if (audit.actionClass !== 'instrumentation') {
        if (audit.result === 'refused-by-guard' && live.mayInject) {
          return {
            rejected: `the tool reported the control layer refused the action, but the control layer now reports mayInject=true; the refusal and the record disagree`,
          }
        }
        if (audit.result === 'accepted' && !live.mayInject) {
          return {
            rejected: `the tool reported an accepted click, but the control layer reports mayInject=false (${live.state}); an action cannot be accepted while injection is forbidden`,
          }
        }
      }

      // ---- 2b. INSTRUMENTATION is held to a different requirement, not a weaker one.
      //
      //       The requirement is ANCHORED OUTSIDE THE TOOL: the control layer must have
      //       recorded more operator events than the mission recorded before the step began.
      //       A tool can fabricate any audit it likes; it cannot move a counter in another
      //       process.
      if (audit.actionClass === 'instrumentation') {
        if (live.operatorEvents <= expected.baselineOperatorEvents) {
          return {
            rejected: `the tool claims an operator event, but the control layer has recorded ${live.operatorEvents} operator events against a pre-step baseline of ${expected.baselineOperatorEvents}; nothing was injected during this step, so the claim cannot be corroborated`,
          }
        }

        const { diagnostics } = await readHookDiagnostics(src)
        const claimedHits =
          (claimed?.audit?.controlResponse as { livenessProbeHits?: number } | undefined)?.livenessProbeHits

        // The tool's view of the probe count may legitimately be BEHIND the verifier's, because
        // the verifier's own `/hooks` read injects one. What must never happen is the tool
        // claiming MORE probes than the control layer has ever recorded.
        //
        // The first version of this check had the comparison inverted - it rejected a claim for
        // being behind and passed a claim for being ahead, which is how a fabricated 999 sailed
        // through and simultaneously rejected the genuine self-test.
        if (typeof claimedHits === 'number' && claimedHits > diagnostics.livenessProbeHits) {
          return {
            rejected: `the tool claimed ${claimedHits} liveness probe hits, but the control layer has only ever recorded ${diagnostics.livenessProbeHits}; an event cannot be reported that the control layer never saw`,
          }
        }
        if (!diagnostics.hookThreadAlive || !diagnostics.keyboardHookInstalled) {
          return {
            rejected: `the self-test cannot corroborate attribution while the hook is unhealthy (thread=${diagnostics.hookThreadAlive}, keyboard=${diagnostics.keyboardHookInstalled})`,
          }
        }
        if (diagnostics.livenessFailures > 0) {
          return {
            rejected: `the control layer has recorded ${diagnostics.livenessFailures} liveness failure(s); the hook is not trustworthy enough to attribute anything`,
          }
        }
      }

      // ---- 3. if input was claimed, an injection must be recorded by the control layer.
      const saidInput = audit.injected === 'yes'
      if (saidInput && !audit.attribution.inputOccurred) {
        return { rejected: 'the tool claimed input occurred, but the authoritative record shows no input' }
      }
      if (expected.expectInjection && !audit.attribution.inputOccurred) {
        return {
          rejected: `this mission required a real injection, but the control layer recorded none (operator +0, human +0, other-injected +0 in ${audit.controlState})`,
        }
      }
      if (!expected.expectInjection && audit.attribution.inputOccurred) {
        return {
          rejected: `no injection was expected, yet the control layer recorded one (${audit.attribution.verdict}); an unexpected input event is a safety finding, not a pass`,
        }
      }

      // ---- 4. the recorded attribution must match the actor the tool claimed.
      const toolClaimedActor = claimed?.claimedActor
      if (toolClaimedActor) {
        const recorded = audit.attribution.verdict
        const recordedActor =
          recorded === 'operator-proven' ? 'operator'
            : recorded === 'human-proven' ? 'human'
              : 'indeterminate'
        if (recordedActor !== toolClaimedActor) {
          return {
            rejected: `the tool attributed the action to "${toolClaimedActor}", but the control layer's record says "${recorded}" (${audit.attribution.basis})`,
          }
        }
      }

      // ---- Accept. Note what is being claimed: the RECORD is truthful, which is a different
      //      claim from the action having succeeded.
      const v = audit.attribution.verdict
      const evidenceText =
        `${audit.stepId}: ${audit.actionType} -> ${audit.result}; class ${audit.actionClass}; ` +
        `input ${audit.injected}; attribution ${v}; control ${audit.controlState}` +
        `${audit.halted ? ` (halted: ${audit.blockingReason ?? 'no reason given'})` : ''}; ${audit.attribution.basis}`

      // The evidence names the action CLASS, because a reader must be able to tell a user
      // action from the control layer checking itself. Those two have different permission
      // rules, and an audit that did not say which applied would be hiding the one place its
      // rules are relaxed.

      // When the record says attribution is unproven or defective, that is reported as its own
      // evidence kind rather than folded into a success. A reader must be able to see it.
      if (v === 'attribution-unproven' || v === 'attribution-defective') {
        return {
          evidence: {
            kind: 'input-unattributed',
            detail: evidenceText,
            verdict: v,
          } as Evidence,
        }
      }

      return {
        evidence: {
          kind: 'input-attributed',
          detail: evidenceText,
          actor: v === 'operator-proven' ? 'operator' : v === 'human-proven' ? 'human' : 'none',
          proven: isProofOfAction(audit.attribution),
        } as Evidence,
      }
    },
  }
}