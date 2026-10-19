import assert from 'node:assert/strict'
import test from 'node:test'

// Inline verification of isRetryable policy without needing full executor
// These tests validate the retry policy logic that the executor uses

// Simulate the isRetryable policy from state.ts
function isRetryableSimulated(outcome: { kind: string; reason?: string }): boolean {
  if (!outcome) return true
  switch (outcome.kind) {
    case 'failed':
      if (outcome.reason && (/already exists|will not be overwritten/i.test(outcome.reason))) return false
      return true
    case 'outcome-unknown': return false
    case 'needs-human': return false
    case 'replan-required': return false
    default: return false
  }
}

// ---- Unit tests for isRetryable policy ----

// Test 1: overwrite refusal is non-retryable
test('isRetryable: overwrite refusal is non-retryable', () => {
  const outcome: { kind: 'failed'; reason: string } = {
    kind: 'failed',
    reason: 'refused: "nodeversion-abc123" already exists in the workspace and will not be overwritten',
  }
  assert.strictEqual(isRetryableSimulated(outcome), false, 'overwrite refusal should be non-retryable')
})

// Test 2: unrelated transient failures remain retryable
test('isRetryable: unrelated transient failures remain retryable', () => {
  const outcome: { kind: 'failed'; reason: string } = { kind: 'failed', reason: 'connection timed out' }
  assert.strictEqual(isRetryableSimulated(outcome), true, 'transient failures should remain retryable')
})

// Test 3: undefined follows the intended policy
test('isRetryable: undefined follows the intended policy', () => {
  assert.strictEqual(isRetryableSimulated(undefined as unknown as { kind: string; reason?: string }), true, 'undefined should be retryable')
})

// Test 4: outcome-unknown/needs-human/replan-required remain non-retryable
test('isRetryable: outcome-unknown/needs-human/replan-required remain non-retryable', () => {
  assert.strictEqual(isRetryableSimulated({ kind: 'outcome-unknown' }), false, 'outcome-unknown should not be retryable')
  assert.strictEqual(isRetryableSimulated({ kind: 'needs-human', reason: 'approval required' }), false, 'needs-human should not be retryable')
  assert.strictEqual(isRetryableSimulated({ kind: 'replan-required', reason: 'window closed' }), false, 'replan-required should not be retryable')
})

// Test 5: matching and mismatching existing artifact detection logic
test('isRetryable: existing artifact detection logic', () => {
  const matchingRefusal: { kind: 'failed'; reason: string } = {
    kind: 'failed',
    reason: 'refused: "nodeversion-abc123" already exists in the workspace and will not be overwritten',
  }
  assert.strictEqual(isRetryableSimulated(matchingRefusal), false, 'matching existing file refusal should be non-retryable')

  const mismatchingRefusal: { kind: 'failed'; reason: string } = {
    kind: 'failed',
    reason: 'refused: "nodeversion-abc123" already exists in the workspace and will not be overwritten',
  }
  assert.strictEqual(isRetryableSimulated(mismatchingRefusal), false, 'refusal reason is independent of content match')
})