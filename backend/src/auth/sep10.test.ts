import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, StrKey, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";

// The environment is deliberately assigned *before* importing project
// modules: env.ts parses it at import time and dotenv does not override values.
const server = Keypair.random();
const keeper = Keypair.random();
const client = Keypair.random();
const stranger = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";
const homeDomain = "localhost";
const webAuthDomain = "localhost:3001";
const jwtSecret = "a".repeat(32);

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: passphrase,
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: "unused",
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  SEP10_SIGNING_SECRET: server.secret(),
  JWT_SECRET: jwtSecret,
  WEB_AUTH_DOMAIN: webAuthDomain,
  HOME_DOMAIN: homeDomain,
});

const { buildChallenge, verifyChallenge, issueJwt, verifyJwt, sep10SigningKey } =
  await import("./sep10.js");

function signChallenge(xdr: string, signer: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function sdkChallenge(
  signer: Keypair,
  domain = homeDomain,
  authDomain = webAuthDomain
): string {
  return WebAuth.buildChallengeTx(
    signer,
    client.publicKey(),
    domain,
    300,
    passphrase,
    authDomain
  );
}

describe("SEP-10 challenge signing and verification (#80)", () => {
  it("uses the explicit SEP10_SIGNING_SECRET, not the keeper key", () => {
    assert.equal(sep10SigningKey, server.publicKey());
    assert.notEqual(sep10SigningKey, keeper.publicKey());
  });

  it("round-trips a challenge signed by the claimed client account", () => {
    const challenge = buildChallenge(client.publicKey(), homeDomain);
    assert.deepEqual(verifyChallenge(signChallenge(challenge, client)), {
      account: client.publicKey(),
    });
  });

  it("rejects a challenge signed only by the server", () => {
    assert.throws(() => verifyChallenge(buildChallenge(client.publicKey(), homeDomain)));
  });

  it("rejects a challenge signed by an unrelated account", () => {
    assert.throws(() => {
      const challenge = buildChallenge(client.publicKey(), homeDomain);
      verifyChallenge(signChallenge(challenge, stranger));
    });
  });

  it("rejects a client-signed challenge with the wrong home domain", () => {
    assert.throws(() => verifyChallenge(signChallenge(sdkChallenge(server, "evil.example"), client)));
  });

  it("rejects a client-signed challenge with the wrong web_auth_domain", () => {
    assert.throws(() =>
      verifyChallenge(signChallenge(sdkChallenge(server, homeDomain, "other.example"), client))
    );
  });

  it("rejects a challenge issued by a different server key", () => {
    assert.throws(() => verifyChallenge(signChallenge(sdkChallenge(stranger), client)));
  });

  it("rejects malformed challenge XDR", () => {
    assert.throws(() => verifyChallenge("not xdr"));
  });
});

describe("SEP-10 JWT issuing and validation (#80)", () => {
  it("issues a token for the account with an exact one-hour lifetime", () => {
    const token = issueJwt(client.publicKey());
    assert.equal(verifyJwt(token).sub, client.publicKey());
    const claims = jwt.decode(token) as jwt.JwtPayload;
    assert.equal(claims.sub, client.publicKey());
    assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 3600);
  });

  it("rejects an expired JWT", () => {
    const expired = jwt.sign({ sub: client.publicKey() }, jwtSecret, { expiresIn: -10 });
    assert.throws(() => verifyJwt(expired), /jwt expired/i);
  });

  it("rejects a payload modified without re-signing", () => {
    const token = issueJwt(client.publicKey());
    const [header, payload, signature] = token.split(".");
    const forgedClaims = {
      ...(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as object),
      sub: stranger.publicKey(),
    };
    const forged = [header, Buffer.from(JSON.stringify(forgedClaims)).toString("base64url"), signature].join(".");
    assert.throws(() => verifyJwt(forged), /invalid signature/i);
  });

  it("rejects a token signed with a different secret", () => {
    const foreignToken = jwt.sign(
      { sub: client.publicKey() },
      "b".repeat(32),
      { expiresIn: "1h" }
    );
    assert.throws(() => verifyJwt(foreignToken), /invalid signature/i);
  });
});
