/**
 * THE CONTROL-CORE PROOF GATE.
 *
 * Run: npm run control:proofs      (needs the operator host: npm run control:up)
 *
 * Until M17 these five proofs had never executed, and the repository cited them as evidence that
 * takeover, the latched stop and no-self-release hold. A proof nobody runs is documentation with a
 * passing exit code, and that is the single worst thing this directory can be.
 *
 * So the gate is real: it runs every proof, classifies the outcome into PASS / FAILED / INCONCLUSIVE,
 * and fails when anything is not a clean pass. It exits non-zero TODAY, because two proofs are
 * inconclusive (the host's pixel-capture endpoints do not respond) and two report failures.
 * That is the correct state to be in, and it will stay red until it is fixed rather than being
 * quietly softened.
 */
import { runAllProofs, PROOFS } from './proof-kit.mjs'

process.exit(runAllProofs({ names: PROOFS }))
