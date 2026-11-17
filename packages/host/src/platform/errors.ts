import { ciGateProofCoverage } from "./ci-gate-proof-coverage.ts";

/** A user-correctable input problem, found by a feature's own domain rules. */
export class InvalidInput extends Error {}

/** The thing a request names does not exist. */
export class NotFound extends Error {}

if (process.env.CLAUDEBOT_CI_GATE_PROOF === "1") ciGateProofCoverage();
