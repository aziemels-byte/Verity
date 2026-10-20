import type { SubmissionTable } from "@verity/db";
import type { Selectable } from "kysely";
import { db } from "../../db.js";
import { env } from "../../config/env.js";
import { keeperKeypair } from "../../chain/keeper.js";
import { canonicalJson } from "../../chain/canonical.js";

/** Where an attestation has been delivered. Stellar 8004's ingestion schema
 * is not published (PRD §16 open question 3), so nothing is pushed anywhere:
 * the attestation is signed, stored, and served by this API. "none" says
 * exactly that rather than naming a registry it never reached. */
export const ATTESTATION_TARGET = "none";

type AttestationSubmission = Pick<
  Selectable<SubmissionTable>,
  | "id"
  | "agent_id"
  | "escrow_ref"
  | "chain_submission_id"
  | "task_type"
  | "status"
  | "resolution_method"
  | "chain_tx_hash"
  | "finalize_tx_hash"
>;

type AttestationVote = {
  stellar_account: string;
  match: boolean | null;
  tx_hash: string | null;
};

/** Build exactly the versioned payload stored by the attestation export.
 * Caller supplies the timestamp so it can be reproduced in tests. */
export function buildAttestationPayload(
  submission: AttestationSubmission,
  votes: AttestationVote[],
  issuedAt: Date
) {
  return {
    schema: "verity.attestation.v2",
    network_passphrase: env.NETWORK_PASSPHRASE,
    escrow_gate_contract_id: env.ESCROW_GATE_CONTRACT_ID,
    attestor: { type: "verity-verification-layer", stellar_account: keeperKeypair.publicKey() },
    subject: {
      agent_stellar_account: submission.agent_id,
      escrow_ref: submission.escrow_ref,
      submission_id: submission.id,
      chain_submission_id: submission.chain_submission_id,
    },
    claim: {
      task_type: submission.task_type,
      verdict: submission.status,
      resolution_method: submission.resolution_method,
      attestations: votes.map((v) => ({
        reexecutor: v.stellar_account,
        matched: v.match,
        tx_hash: v.tx_hash,
      })),
    },
    submit_tx_hash: submission.chain_tx_hash,
    finalize_tx_hash: submission.finalize_tx_hash,
    issued_at: issuedAt.toISOString(),
  };
}

/** Lowercase/base64 transport for an Ed25519 signature over canonical JSON bytes. */
export function signAttestation(canonical: string): string {
  return Buffer.from(keeperKeypair.sign(Buffer.from(canonical))).toString("base64");
}

/**
 * A versioned payload describing a submission's terminal verdict, signed with
 * Verity's keeper key. Every field is read from the mirrored chain state; the
 * evidence is the list of on-chain attestation transactions, which anyone can
 * check independently.
 *
 * The signature covers the canonical JSON of the payload (keys sorted, no
 * whitespace), so it can be re-derived from the stored JSON and verified.
 * Returns true when this call created the attestation.
 */
export async function exportAttestation(submissionId: string): Promise<boolean> {
  const submission = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionId)
    .executeTakeFirstOrThrow();
  if (!["verified", "slashed", "expired_unverified"].includes(submission.status)) return false;
  if (!submission.resolution_method) return false; // not mirrored from chain yet; retried at the next settle pass

  const votes = await db
    .selectFrom("replay")
    .innerJoin("reexecutor", "reexecutor.id", "replay.reexecutor_id")
    .select(["reexecutor.stellar_account", "replay.match", "replay.tx_hash"])
    .where("replay.submission_id", "=", submissionId)
    .where("replay.status", "=", "confirmed_onchain")
    .orderBy("replay.tx_hash")
    .execute();

  const payload = buildAttestationPayload(submission, votes, new Date());
  const canonical = canonicalJson(payload);
  const signature = signAttestation(canonical);

  // One attestation per submission: nothing is inserted when one already exists.
  const inserted = await db
    .insertInto("attestation_export")
    .values({
      submission_id: submissionId,
      target_registry: ATTESTATION_TARGET,
      payload: canonical,
      signature,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  return Boolean(inserted);
}
