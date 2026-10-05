/**
 * THE PROVIDER INTERFACE, kept separate from its implementation.
 *
 * `world.ts` holds the SHAPE of an observation and `local.ts` holds a provider that produces one.
 * This file holds the one method that joins them, so that:
 *
 *   - the supervisor can depend on "something that can observe" without depending on the filesystem
 *   - a control can substitute a provider that reports whatever it likes, including nonsense, and the
 *     planner's reaction to nonsense becomes testable
 *   - a future remote or model-backed observer is a new implementation of one method
 *
 * Splitting the interface out is a small thing that costs a file. It is worth it because the
 * alternative - importing `LocalObservationProvider` wherever an observer is needed - makes the
 * read-only claim depend on importing a specific class, and a control cannot replace it without
 * replacing the whole import.
 */

import type { WorldState, ObservationScope } from './world.ts'

export interface ObservationProvider {
  readonly name: string
  /** What this provider can report, so a caller can decide whether asking is worthwhile. */
  observes(): readonly string[]
  /**
   * Reports the state of `scope`. Read-only by contract.
   *
   * `WorldState` has no methods and no handles, so whatever this returns can be logged, compared and
   * handed to a planner without granting the holder any capability it did not already have.
   */
  observe(scope: ObservationScope): WorldState
}

export { LocalObservationProvider, NoObservationProvider } from './local.ts'
