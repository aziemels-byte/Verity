import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// The verifier and signer must use only test-generated keys and settings.
// Project modules parse environment variables as soon as they are imported.
const keeper = Keypair.random();
const verifier = Keypair.random();
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: "unused",
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { buildAttestationPayload, signAttestation } = await import("./export.js");
const { canonicalJson } = await import("../../chain/canonical.js");

const issuedAt = new Date("2026-10-19T12:34:56.789Z");
const submission: Parameters<typeof buildAttestationPayload>[0] = {
  id: "attestation-test-uuid",
  agent_id: "GTESTACCOUNT",
  escrow_ref: "escrow-example",
  chain_submission_id: "77",
  task_type: "deterministic",
  status: "verified",
  resolution_method: "reexecution_consensus",
  chain_tx_hash: "submission-tx",
  finalize_tx_hash: "finalization-tx",
};
const votes: Parameters<typeof buildAttestationPayload>[1] = [
  { stellar_account: verifier.publicKey(), match: true, tx_hash: "vote-tx" },
  { stellar_account: "GSECOND", match: null, tx_hash: null },
];

function verify(payload: ReturnType<typeof buildAttestationPayload>, signature: string): boolean {
  const canonicalBytes = Buffer.from(canonicalJson(payload));
  return Keypair.fromPublicKey(payload.attestor.stellar_account).verify(
    canonicalBytes,
    Buffer.from(signature, "base64")
  );
}

describe("signed attestation export (#81)", () => {
  it("builds the exact version-2 payload with a provided issuance date", () => {
    const payload = buildAttestationPayload(submission, votes, issuedAt);
    assert.deepEqual(payload, {
      schema: "verity.attestation.v2",
      network_passphrase: "Test SDF Network ; September 2015",
      escrow_gate_contract_id: StrKey.encodeContract(Buffer.alloc(32)),
      attestor: {
        type: "verity-verification-layer",
        stellar_account: keeper.publicKey(),
      },
      subject: {
        agent_stellar_account: "GTESTACCOUNT",
        escrow_ref: "escrow-example",
        submission_id: "attestation-test-uuid",
        chain_submission_id: "77",
      },
      claim: {
        task_type: "deterministic",
        verdict: "verified",
        resolution_method: "reexecution_consensus",
        attestations: [
          { reexecutor: verifier.publicKey(), matched: true, tx_hash: "vote-tx" },
          { reexecutor: "GSECOND", matched: null, tx_hash: null },
        ],
      },
      submit_tx_hash: "submission-tx",
      finalize_tx_hash: "finalization-tx",
      issued_at: "2026-10-19T12:34:56.789Z",
    });
  });

  it("verifies the signature against the attestor's Ed25519 public key", () => {
    const payload = buildAttestationPayload(submission, votes, issuedAt);
    assert.equal(verify(payload, signAttestation(canonicalJson(payload))), true);
  });

  it("rejects a changed verdict with the same original signature", () => {
    const payload = buildAttestationPayload(submission, votes, issuedAt);
    const signature = signAttestation(canonicalJson(payload));
    const tampered = { ...payload, claim: { ...payload.claim, verdict: "slashed" } };
    assert.equal(verify(tampered, signature), false);
  });

  it("rejects a modified vote with the same original signature", () => {
    const payload = buildAttestationPayload(submission, votes, issuedAt);
    const signature = signAttestation(canonicalJson(payload));
    const tampered = {
      ...payload,
      claim: {
        ...payload.claim,
        attestations: payload.claim.attestations.map((vote, index) =>
          index === 0 ? { ...vote, matched: false } : vote
        ),
      },
    };
    assert.equal(verify(tampered, signature), false);
  });

  it("produces deterministic canonical JSON and deterministic Ed25519 signatures", () => {
    const first = canonicalJson(buildAttestationPayload(submission, votes, issuedAt));
    const second = canonicalJson(buildAttestationPayload(submission, votes, issuedAt));
    assert.equal(first, second);
    assert.equal(signAttestation(first), signAttestation(second));
  });

  it("keeps window elapsed, consensus, and ZK resolution methods distinct", () => {
    const methods = [
      "reexecution_consensus",
      "window_elapsed",
      "zk_proof",
    ] as const;
    const canonical = methods.map((resolution_method) => {
      const payload = buildAttestationPayload({ ...submission, resolution_method }, votes, issuedAt);
      assert.equal(payload.claim.resolution_method, resolution_method);
      return canonicalJson(payload);
    });
    assert.equal(new Set(canonical).size, 3);
  });
});
