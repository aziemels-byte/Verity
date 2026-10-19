import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { escrowGateFor } from "../../chain/clients.js";
import { minChallengerBond, readSubmission } from "../../chain/actions.js";
import { env } from "../../config/env.js";
import { parseGateCall, relaySignedXdr } from "../../chain/rpc.js";
import { bufFromHex, sha256Bytes, toChainTaskType } from "../../chain/mappers.js";
import { canonicalJson } from "../../chain/canonical.js";
import { HttpError } from "../../http-error.js";
import { findOrCreateMarketplaceForAccount } from "../marketplaces/routes.js";
import { artifactExists } from "../artifacts/storage.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256 digest");
const stroops = z.string().regex(/^\d+$/, "must be an integer amount in stroops");

const submitBody = z.object({
  escrow_ref: z.string().min(1),
  // "unverifiable" is in the taxonomy but has no on-chain path in Phase 1 —
  // the contract rejects it, so it is rejected here with a clear message.
  task_type: z.enum(["deterministic", "retrieval"]),
  input_hash: sha256Hex,
  claimed_output_hash: sha256Hex,
  input_ref: z.string().optional(),
  function_hash: z.string().optional(),
  function_ref: z.string().optional(),
  claimed_output_ref: z.string().optional(),
  escrow_value: stroops,
  bond_amount: stroops,
  idempotency_key: z.string().min(1),
});

/** An artifact reference is the storage_ref POST /v1/artifacts returned,
 * whose last path segment is the content hash. The artifact must really be
 * here — re-executors fetch it from this backend to replay the work, and a
 * submission pointing at nothing could never be replayed, only wait out its
 * window — and where the contract commits to a hash, it must be that hash. */
async function requireArtifact(label: string, ref: string | undefined, committedHash?: string) {
  if (!ref) return;
  const hash = ref.split(/[\\/]/).pop() ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new HttpError(400, `${label} is not an artifact reference returned by POST /v1/artifacts`);
  }
  if (committedHash && hash !== committedHash) {
    throw new HttpError(400, `${label} holds different content than the hash being committed on-chain`);
  }
  if (!(await artifactExists(hash))) {
    throw new HttpError(400, `${label} points at an artifact that has not been uploaded`);
  }
}

export async function submissionsRoutes(app: FastifyInstance) {
  // Read-only list addition (beyond the PRD's literal §9 list, which only
  // specifies a per-id GET) — the dashboard has nothing to render a
  // submissions feed from without it, and faking one client-side would
  // violate the no-mocked-data requirement.
  app.get("/v1/submissions", async (req, reply) => {
    const query = z
      .object({
        marketplace_id: z.string().uuid().optional(),
        agent_id: z.string().optional(),
        status: z
          .enum(["pending", "verified", "disputed", "slashed", "expired_unverified"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        include_drafts: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    let qb = db.selectFrom("submission").selectAll().orderBy("submitted_at", "desc").orderBy("id");
    // A draft is a row whose submit() transaction was built but never signed
    // and relayed — it does not exist on-chain, so it is not listed by default.
    if (query.include_drafts !== "true") qb = qb.where("chain_submission_id", "is not", null);
    if (query.marketplace_id) qb = qb.where("marketplace_id", "=", query.marketplace_id);
    if (query.agent_id) qb = qb.where("agent_id", "=", query.agent_id);
    if (query.status) qb = qb.where("status", "=", query.status);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    // Derive the count from the exact same filtered query, before paging.
    // Clear SELECT/ORDER BY so Postgres only computes the matching row count.
    const [page, count] = await Promise.all([
      qb.limit(limit).offset(offset).execute(),
      qb
        .clearSelect()
        .clearOrderBy()
        .select((eb) => eb.fn.countAll<string>().as("total"))
        .executeTakeFirstOrThrow(),
    ]);
    reply.header("x-total-count", String(Number(count.total)));
    reply.header("x-limit", String(limit));
    reply.header("x-offset", String(offset));
    return page;
  });

  // Build-sign-relay-confirm step 1: create a pending row and hand back
  // unsigned XDR for the agent to sign with their own key. Verity never
  // holds the agent's signing key.
  app.post("/v1/submissions", { preHandler: requireAuth }, async (req, reply) => {
    const body = submitBody.parse(req.body);
    const agent = req.stellarAccount!;

    const existing = await db
      .selectFrom("submission")
      .selectAll()
      .where("idempotency_key", "=", body.idempotency_key)
      .executeTakeFirst();
    if (existing && existing.agent_id !== agent) {
      // Never hand one account another account's submission.
      throw new HttpError(409, "idempotency_key is already in use");
    }
    if (existing?.chain_submission_id) {
      // Already signed and on-chain: nothing left to sign.
      return { submission: existing, unsigned_transaction_xdr: null, network_passphrase: env.NETWORK_PASSPHRASE };
    }

    if (body.task_type === "deterministic" && (!body.function_ref || !body.input_ref)) {
      reply.code(400);
      return { error: "deterministic submissions need function_ref and input_ref artifacts for re-executors to replay" };
    }
    if (body.task_type === "retrieval" && !body.input_ref) {
      reply.code(400);
      return { error: "retrieval submissions need an input_ref artifact holding the request spec" };
    }
    await requireArtifact("input_ref", body.input_ref, body.input_hash);
    await requireArtifact("function_ref", body.function_ref, body.function_hash);
    await requireArtifact("claimed_output_ref", body.claimed_output_ref, body.claimed_output_hash);

    // Build (and simulate) first: a submission the contract would reject —
    // bond too low, insufficient balance — fails here with the contract's own
    // error and never leaves an orphan row behind.
    const client = escrowGateFor(agent);
    const assembled = await client.submit({
      agent,
      escrow_ref: sha256Bytes(body.escrow_ref),
      escrow_value: BigInt(body.escrow_value),
      task_type: toChainTaskType(body.task_type),
      input_hash: bufFromHex(body.input_hash),
      output_hash: bufFromHex(body.claimed_output_hash),
      bond: BigInt(body.bond_amount),
    });
    const unsignedXdr = assembled.toXDR();
    const values = {
      escrow_ref: body.escrow_ref,
      task_type: body.task_type,
      input_hash: body.input_hash,
      input_ref: body.input_ref ?? null,
      function_hash: body.function_hash ?? null,
      function_ref: body.function_ref ?? null,
      claimed_output_hash: body.claimed_output_hash,
      claimed_output_ref: body.claimed_output_ref ?? null,
      bond_amount: body.bond_amount,
      escrow_value: body.escrow_value,
      // A transaction's hash does not cover its signatures, so the hash of
      // what we just built is the hash it will have on-chain. The indexer
      // uses it to tie the SubmissionCreated event back to this exact row,
      // and the relay step uses it to accept only this transaction.
      chain_tx_hash: Buffer.from(assembled.built!.hash()).toString("hex"),
    };

    if (existing) {
      // A retry of a draft that was never signed: the transaction built the
      // first time may have expired, so the draft is pointed at a fresh one.
      const row = await db
        .updateTable("submission")
        .set({ ...values, updated_at: new Date() })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { submission: row, unsigned_transaction_xdr: unsignedXdr, network_passphrase: env.NETWORK_PASSPHRASE };
    }

    const marketplace = await findOrCreateMarketplaceForAccount(agent);
    const row = await db
      .insertInto("submission")
      .values({
        ...values,
        marketplace_id: marketplace.id,
        agent_id: agent,
        bond_asset: "native",
        challenge_window_s: 0, // set by the contract at submit() time; filled in on relay confirm
        idempotency_key: body.idempotency_key,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    reply.code(201);
    return {
      submission: row,
      unsigned_transaction_xdr: unsignedXdr,
      network_passphrase: env.NETWORK_PASSPHRASE,
    };
  });

  // Build-sign-relay-confirm step 2: relay the agent-signed XDR to real
  // testnet and reconcile the row with the real on-chain result. The chain
  // indexer independently reconciles the same event, so this is an
  // optimistic fast-path for the caller's own response, not the sole writer.
  app.post("/v1/submissions/:id/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const draft = await db.selectFrom("submission").selectAll().where("id", "=", params.id).executeTakeFirst();
    if (!draft) {
      reply.code(404);
      return { error: "not found" };
    }
    if (draft.agent_id !== req.stellarAccount) {
      reply.code(403);
      return { error: "only the submitting agent can relay this submission" };
    }
    if (draft.chain_submission_id) return { submission: draft, tx_hash: draft.chain_tx_hash };

    // Checked before anything is broadcast: only the exact transaction built
    // for this draft is relayed, never whatever the caller happened to sign.
    if (parseGateCall(body.signed_transaction_xdr).hash !== draft.chain_tx_hash) {
      reply.code(400);
      return { error: "signed transaction is not the one built for this submission" };
    }
    const { hash, returnValue } = await relaySignedXdr(body.signed_transaction_xdr);
    const chainSubmissionId = String(returnValue);
    const onChain = await readSubmission(chainSubmissionId);

    const row = await db
      .updateTable("submission")
      .set({
        chain_submission_id: chainSubmissionId,
        chain_tx_hash: hash,
        challenge_window_s: onChain ? Number(onChain.challenge_window_s) : 0,
        min_challenger_bond: onChain ? minChallengerBond(onChain).toString() : null,
        submitted_at: onChain ? new Date(Number(onChain.submitted_at) * 1000) : undefined,
        updated_at: new Date(),
      })
      .where("id", "=", params.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { submission: row, tx_hash: hash };
  });

  app.get("/v1/submissions/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const submission = await db
      .selectFrom("submission")
      .selectAll()
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission) {
      reply.code(404);
      return { error: "not found" };
    }
    const replays = await db
      .selectFrom("replay")
      .innerJoin("reexecutor", "reexecutor.id", "replay.reexecutor_id")
      .selectAll("replay")
      .select("reexecutor.stellar_account as reexecutor_account")
      .where("replay.submission_id", "=", params.id)
      .orderBy("replay.assigned_at")
      .execute();
    const spotChecks = await db
      .selectFrom("spot_check")
      .innerJoin("reexecutor", "reexecutor.id", "spot_check.reexecutor_id")
      .selectAll("spot_check")
      .select("reexecutor.stellar_account as reexecutor_account")
      .where("spot_check.submission_id", "=", params.id)
      .orderBy("spot_check.sampled_at")
      .execute();
    const challenge = await db
      .selectFrom("challenge")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    const attestation = await db
      .selectFrom("attestation_export")
      .select("id")
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    return {
      submission,
      replays,
      spot_checks: spotChecks,
      challenge: challenge ?? null,
      has_attestation: Boolean(attestation),
    };
  });

  app.get("/v1/submissions/:id/proof", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const submission = await db
      .selectFrom("submission")
      .select("id")
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission) {
      reply.code(404);
      return { error: "not found" };
    }
    const proof = await db
      .selectFrom("zk_proof")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    if (proof) return proof;
    // Honest by construction: nothing in Phase 1 produces or checks a proof —
    // EscrowGate rejects the ZK resolution method outright — so there is
    // never a fabricated proof here.
    return {
      available: false,
      phase: 1,
      reason:
        "ZK proving is not active in Phase 1: EscrowGate accepts no proofs and the ZKVerifierRegistry has no verifiers. Any verdict on this submission comes from bonded re-execution, not a cryptographic proof.",
    };
  });

  // The signed record of a terminal verdict. `canonical` is the exact string
  // the signature covers, so it can be verified against `signer` directly.
  app.get("/v1/submissions/:id/attestation", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db
      .selectFrom("attestation_export")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    if (!row) {
      reply.code(404);
      return { error: "no attestation for this submission (it is issued once a terminal verdict has settled)" };
    }
    const payload = row.payload as { attestor?: { stellar_account?: string } };
    return {
      payload,
      canonical: canonicalJson(payload),
      signature: row.signature,
      signature_algorithm: "ed25519",
      signer: payload.attestor?.stellar_account ?? null,
      // Signed and served here; not pushed to any external registry.
      delivered_to: row.target_registry === "none" ? null : row.target_registry,
      issued_at: row.exported_at,
    };
  });
}
