# Verity

An optimistic verification layer for Soroban escrow. A marketplace's escrow
contract asks Verity's `EscrowGate` for a verdict before it pays an AI agent;
the verdict comes from bonded re-executors replaying the agent's work, with a
challenge window and slashing behind it.

**What is and is not proven.** Phase 1 (this repo) is *economically enforced
and replay-checked*. It is not cryptographic proof of model correctness.
`EscrowGate` accepts no ZK proofs: its challenge resolution rejects the ZK
method outright, so no code path can report a ZK-verified result. The
`ZKVerifierRegistry` contract is deployed empty as the anchor for Phase 2. See
[`prd-01-zkml-agent-truth.md`](prd-01-zkml-agent-truth.md) for the full scope.

## How a submission is verified

```
agent ── submit() + bond ──▶ EscrowGate (Soroban, testnet)
                                 │ SubmissionCreated event
                                 ▼
                    backend indexer ── assigns online re-executors
                                 │
        re-executor agents ◀─────┘  fetch the declared artifacts, re-derive the
                 │                  output, hash it canonically
                 └── attest_replay(matched) ──▶ EscrowGate (bonded vote)
                                                   │
backend keeper ── finalize() / resolve_challenge() ┘  verdict + bond settlement
               └─ release_attestation_lock()  slashes a wrong-side voter, then
                                              unlocks the stake
```

| Task type | How it is checked |
|---|---|
| `deterministic` | A quorum (plus one spare) replays the declared function over the declared input in a WebAssembly sandbox and votes match/mismatch. A bonded supermajority finalizes immediately. |
| `retrieval` | One sampled re-executor re-fetches the declared URL (spot-check). A match leaves the submission to be verified by default when its challenge window closes; a mismatch escalates it — and the agent's other pending submissions — to a full quorum. |

Every verdict records how it was reached, and the dashboard shows it:

| Verdict | Reached by | Meaning |
|---|---|---|
| `verified` | re-execution consensus | A bonded supermajority replayed the work and it matched. Agent bond returned. |
| `verified` | window elapsed | Nobody challenged and no quorum formed. **Not replayed to quorum**; shown as "Verified by default". Agent bond returned. |
| `slashed` | re-execution consensus | A bonded supermajority found a mismatch. Agent bond forfeited. |
| `expired_unverified` | window elapsed | Either a challenge that no quorum could resolve, or a window that closed with a mismatch reported but no quorum. Nothing was established; every bond is returned and nobody is slashed. |

Anyone can open a bonded challenge inside the window. If the challenge is
upheld, the challenger gets their bond back plus 20% of the agent's, and the
rest of the agent's bond goes to the admin/treasury account. If it is rejected,
the challenger's bond goes to the agent.

A re-executor whose vote a bonded consensus proves wrong loses a fixed share
of its stake (10% as deployed). The amount is set on-chain and applied when
its stake lock is released, so it can be neither chosen by the caller nor
escaped by withdrawing first. A verdict that only defaulted proves nobody
wrong and slashes nobody.

Outputs are hashed as **canonical JSON** (keys sorted, no whitespace), so key
order and formatting never cause a false mismatch. The same function lives in
`reexecutor-agent/src/sandbox/canonical.ts`, `frontend/src/lib/canonical.ts`
and `backend/src/chain/canonical.ts`.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Soroban contracts: `escrow-gate`, `zk-verifier-registry`, `example-marketplace-escrow` (reference only, not deployed), shared `common` types |
| `backend/` | Fastify API, SEP-10 auth, chain indexer, keeper/scheduler |
| `reexecutor-agent/` | Worker that replays assignments and attests on-chain with its own key |
| `frontend/` | Next.js dashboard (Freighter wallet) |
| `db/` | Kysely schema, migrations, embedded Postgres for Docker-free dev |
| `deployments/<name>.json` | Deployed contract IDs and public keys, one file per deployment |
| `scripts/` | Deploy, bootstrap, approve, bindings, dev runner, smoke test |
| `docs/DEPLOY.md` | Running a public deployment from the container images |

## Run it

Requirements: Node 20+, pnpm 10, [stellar-cli](https://developers.stellar.org/docs/tools/cli).
Docker is not needed. Rust is needed to deploy contracts (the deploy script
builds them) and to change or test them, but not to run against a deployment
that already exists.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres, runs migrations, and starts the backend, one
re-executor agent per bootstrap identity, and the dashboard, all against the
contracts recorded in `deployments/testnet.json`. Ctrl+C stops everything.

- Dashboard: http://localhost:3000
- API: http://localhost:3001

Ports are configurable when those are taken:

```bash
VERITY_API_PORT=4001 VERITY_WEB_PORT=4000 pnpm dev
```

The re-executor agents sign with stellar-cli identities `rex1`…`rex5`
(override with `VERITY_REEXECUTORS="alias1 alias2 alias3"`). On a fresh
machine, or after a testnet reset, create the deployment first:

```bash
scripts/deploy_testnet.sh --force   # deploys contracts, writes deployments/testnet.json
scripts/bootstrap_reexecutors.sh    # stakes rex1..rex5 and approves them as voters
pnpm db:reset                       # the local database still mirrors the old contract
```

`deployments/testnet.json` is the **dev** deployment: 10-minute challenge
windows, used by `pnpm dev` and `pnpm smoke`. A deployment for other people is
separate, with its own contracts and keys — see [`docs/DEPLOY.md`](docs/DEPLOY.md).
`VERITY_DEPLOYMENT=<name>` selects `deployments/<name>.json` in every script.

The stellar-cli keystore is one flat namespace shared by every project on your
machine. The dev deployment uses the short aliases `deployer`, `keeper` and
`rex1`…`rex5`; if another project generates an identity under one of those
names, it replaces yours. The scripts compare the keystore with
`deployments/testnet.json` and stop if the admin or a staked re-executor is no
longer the recorded account (a replaced keeper is only reported: it holds no
authority on-chain). Named deployments use `verity-<name>-…` aliases.

Secrets stay in your stellar-cli keystore. `pnpm dev` reads them at start-up
and passes them to each process through its environment. The only secrets it
writes to disk are in `backend/.env` (gitignored), and only if that file does
not exist; it also creates the local database under `.pgdata/`.

### Prove it works end to end

With `pnpm dev` running, in another terminal:

```bash
pnpm smoke                       # VERITY_API_PORT=4001 pnpm smoke if you changed it
```

This plays an agent, a challenger and one rogue re-executor against the live
stack and real testnet. It checks honest and dishonest deterministic work, a
challenged submission, that a relay endpoint refuses a transaction it was not
built for, honest and dishonest retrieval work, and that a re-executor who
votes wrong is slashed exactly the on-chain rate and can then withdraw. For
every verdict it checks how the contract says it was reached and verifies the
signed attestation. It never attests on a fleet re-executor's behalf — the
running agents do that.

Two slower modes wait out real challenge windows:

```bash
SMOKE_SLOW=1 pnpm smoke          # also: a spot-checked retrieval verifies by default

# with fewer than a quorum online, so no consensus can form:
VERITY_REEXECUTORS="rex1 rex2" pnpm dev
SMOKE_PROFILE=underquorum pnpm smoke
```

The second proves the no-quorum paths: honest work verifies by default (and is
labelled as not replayed), contested work expires unverified, an unresolved
challenge expires with both bonds returned, and nobody is slashed in any of
them.

Smoke submissions are real on-chain records. The script only runs against a
local backend, and refuses a deployment marked public.

### Use the dashboard

Install [Freighter](https://www.freighter.app/), switch it to Testnet, connect,
and use "Fund my testnet account" on the home page. Then:

- **Submissions → New** to submit work. A deterministic example:
  input `{"n": 21}`, function body `return { doubled: input.n * 2 };`,
  claimed output `{"doubled": 42}`. Change the claimed output to anything else
  to watch the bond get slashed.
- **Re-executors → Register** to stake (the on-chain floor is 500 XLM). The
  account then shows as pending until the deployment admin approves it:
  `scripts/approve_reexecutor.sh G...`. Run your own worker with
  `REEXECUTOR_SECRET_KEY=S... ESCROW_GATE_CONTRACT_ID=C... pnpm --filter @verity/reexecutor-agent start`
  (see `reexecutor-agent/.env.example`); work is only assigned to accounts
  whose worker is polling.
- Open a pending submission to challenge it while its window is open.
- A re-executor can withdraw stake from its own page.

## Contracts

```bash
pnpm test:contracts                # cargo test in contracts/
```

`EscrowGate` has no upgrade entrypoint: a contract change means a new
deployment (`scripts/deploy_testnet.sh --force`), a new contract ID in
`deployments/<name>.json`, and re-staking re-executors. Each contract is
configured by its constructor in the same transaction that deploys it. If the
interface changes, regenerate the TypeScript bindings under
`backend/src/chain/generated/` with `scripts/generate_bindings.sh`.

The admin (the deploying account) can change the configuration future
submissions use, and decides which staked accounts may vote while
`reexecutor_allowlist` is on. It cannot set, change or override a verdict.

## API

Verity uses [SEP-10 authentication](#sign-in-and-token-lifetime) and
**build, sign, relay** for state-changing Soroban transactions. The backend
returns unsigned XDR; the caller signs it locally and relays the signature.
The backend never holds users' keys. An authenticated call includes
`Authorization: Bearer <JWT>`. Public calls need no token.

| Method | Endpoint | Bearer token | Purpose |
| --- | --- | --- | --- |
| GET | `/auth?account=G...` | No | SEP-10 challenge and network passphrase |
| POST | `/auth` | No | Exchange signed challenge for a JWT |
| GET | `/.well-known/stellar.toml` | No | SEP-10 authentication metadata |
| GET | `/health`, `/health/live` | No | Readiness and liveness |
| GET | `/v1/config` | No | Live contract configuration |
| POST | `/v1/artifacts` | **Yes** | Upload content-addressed artifact |
| GET | `/v1/artifacts/:hash` | No | Retrieve an artifact by hash |
| POST | `/v1/submissions` | **Yes** | Build `submit()`, with idempotency |
| POST | `/v1/submissions/:id/relay` | **Yes** | Relay signed submission XDR |
| GET | `/v1/submissions` | No | Browse submissions |
| GET | `/v1/submissions/:id` | No | Submission, replay and challenge status |
| GET | `/v1/submissions/:id/attestation` | No | Signed settled-verdict record |
| GET | `/v1/submissions/:id/proof` | No | Proof status (Phase 1: unavailable) |
| POST | `/v1/submissions/:id/challenge` | **Yes** | Build `open_challenge()` |
| POST | `/v1/submissions/:id/challenge/relay` | **Yes** | Relay signed challenge XDR |
| POST | `/v1/reexecutors` | **Yes** | Build registration/stake XDR |
| POST | `/v1/reexecutors/:id/withdraw` | **Yes** | Build withdrawal XDR |
| POST | `/v1/reexecutors/:id/relay` | **Yes** | Relay signed re-executor XDR |
| POST | `/v1/reexecutors/sync` | **Yes** | Mirror an existing on-chain stake |
| GET | `/v1/reexecutors` | No | List re-executors |
| GET | `/v1/reexecutors/:id` | No | Stake, standing and record |
| GET | `/v1/reexecutors/:id/assignments` | **Yes** | Authenticated worker queue |
| GET | `/v1/challenges` | No | Challenge list |
| GET | `/v1/taxonomy` | No | Supported task taxonomy |
| GET | `/v1/reports/verification-rates` | No | Verification statistics |
| POST | `/v1/marketplaces` | **Yes** | Create or find caller's marketplace |
| POST | `/v1/marketplaces/:id/webhooks` | **Yes** | Register the caller's webhook |

Authentication is not authorization to act for another account. For example,
a submitting agent is the only account allowed to relay its submission;
withdrawals, worker assignments and webhook management are limited to
their owning account or marketplace. Such violations return HTTP 403.

### Sign-in and token lifetime

1. Call `GET /auth?account=G...` using the account to authenticate.
   The response contains `{ "transaction": "<challenge XDR>",
   "network_passphrase": "<network>" }`.
2. Sign that SEP-10 challenge with the account's wallet. It is valid for
   **300 seconds**. POST `{ "transaction": "<signed XDR>" }` to `/auth`.
3. On success, the response contains `{ "token": "<JWT>" }`; failed
   challenge validation responds with HTTP 400 and an `error` message.
   The JWT has a **one-hour lifetime** and contains the account in `sub`.
4. Send `Authorization: Bearer <JWT>` for routes marked **Yes** above.

A protected request without a bearer token returns HTTP 401
`{ "error": "missing bearer token" }`; an invalid or expired token
returns HTTP 401 `{ "error": "invalid or expired token" }`.
`/.well-known/stellar.toml` advertises the SEP-10 auth endpoint and
signing key.

### Error shapes and limits

A response's HTTP status is authoritative; inspect the JSON body rather
than assuming every 4xx has identical wording:

| Condition | Status | Example body |
| --- | --- | --- |
| Invalid parameters (Zod validation) | 400 | `{"error":"id: Invalid UUID"}` (path and wording vary) |
| Invalid or missing bearer token | 401 | `{"error":"missing bearer token"}` |
| Attempt to act for another account | 403 | `{"error":"forbidden"}` or an endpoint-specific ownership message |
| Missing submission or other record | 404 | `{"error":"not found"}` (exact message varies) |
| Artifact larger than configured size | 413 | `{"error":"artifact is larger than the 262144-byte limit"}` (default) |
| EscrowGate contract rejection | 422 | `{"error":"EscrowGate rejected the transaction: <ErrorName>","contract_error":"<ErrorName>"}` |
| Unexpected server error | 500 | `{"error":"internal error"}` |

The custom Zod handler joins issues as `<path>: <message>` separated
by semicolons. Other `HttpError` failures preserve their own status and
have only `{ "error": "<message>" }`. For example, the network's 422
transaction rejection is **not** a contract-error response and does not
include `contract_error`. Relay confirmation can time out with HTTP 504;
the transaction may still land, so query its status before retrying.

Rate limiting defaults to **300 requests per minute**
(`RATE_LIMIT_PER_MINUTE`), keyed by JWT account when the bearer token
is valid, otherwise by caller IP. The backend currently exempts URLs
beginning with `/health` from that limiter. The exact rate-limit
response body is not specified here.

`POST /v1/artifacts` accepts `{ "content_base64": "...",
"content_type": "application/json" }` (`content_type` optional).
A successful upload returns HTTP 201 with `content_hash`,
`storage_ref`, `size_bytes` and `content_type`. A single artifact may
be at most **262,144 bytes** by default (`ARTIFACT_MAX_BYTES`);
the full HTTP request body is limited to **1 MiB**.

### Submission idempotency

`POST /v1/submissions` requires a nonempty `idempotency_key`.
The key is checked **across all accounts**, not scoped to one account.
Its response includes `submission`, `unsigned_transaction_xdr`, and
`network_passphrase` in all successful cases.

| Existing state of `idempotency_key` | Status | Result |
| --- | --- | --- |
| New key | 201 | New draft and unsigned XDR to sign |
| Same account; unsigned draft still in database | 200 | Updates draft request values and builds fresh unsigned XDR |
| Same account; already confirmed on-chain | 200 | Existing submission with `unsigned_transaction_xdr: null`; do not sign again |
| Another account already owns the key | 409 | `{"error":"idempotency_key is already in use"}` |

The scheduler purges unsigned drafts older than `DRAFT_TTL_S`
(**3,600 seconds** by default). A draft retry is not the same as
re-relaying a confirmed transaction.

### Network passphrase for wallet signing

`GET /auth` and `POST /v1/submissions` explicitly include
`network_passphrase`. **Challenge build**
(`POST /v1/submissions/:id/challenge`) returns only
`{ "unsigned_transaction_xdr": "..." }` with HTTP 201.
**Re-executor register** (`POST /v1/reexecutors`) and **withdraw**
(`POST /v1/reexecutors/:id/withdraw`) return the relevant
`reexecutor` row and `unsigned_transaction_xdr`, **without**
`network_passphrase`. For those transactions, obtain the passphrase
from `GET /v1/config` or use the known network configuration, not a
hard-coded guess.

Webhooks (HMAC-SHA256 in `x-verity-signature`):
`submission.verified`, `submission.slashed`, `submission.disputed`.

## Known limits

- **Testnet only. Contracts are unaudited.**
- **What "verified" covers.** The input and claimed-output hashes are
  committed on-chain; the function is stored by hash but not committed. A
  verdict means "consistent with the artifacts the agent declared".
- **No escrow is gated yet.** `example-marketplace-escrow` shows the
  integration but is not deployed; `escrow_value` is declared by the agent.
- **Voter set.** Stake is free on testnet, so an open voter set could be
  captured at no cost. Deployments here run with `reexecutor_allowlist` on:
  the admin approves which staked accounts may vote.
- **Sandbox limits.** A replayed function gets 64 MB, a small compute budget,
  no clock and no randomness. Exceeding a limit is a mismatch. A function that
  stalls a re-executor's host without exceeding one gets no vote from it.
- **Assignment** is deterministic and auditable but uniform, not
  stake-weighted. It only picks re-executors whose worker is online, and asks
  another when one goes quiet.
- **Stellar 8004.** Verdicts are stored as signed attestation payloads and
  served by the API; they are not pushed to an 8004 registry, whose ingestion
  schema is not published.
- **False-accept rate** needs a manual audit sample and is reported as `null`.
- **One backend instance** runs the indexer and keeper; artifacts are on its
  local disk; webhooks are delivered once with no retry.
- **Containers.** The three images build, and the full stack has been run
  from them (Postgres, migrations, backend, three re-executors, dashboard)
  and passed the smoke test, using podman with the services started one by
  one. `docker-compose.yml` describes the same services but has not itself
  been executed: the machine this was developed on has no compose provider.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, checks and the PR flow,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for a map of the code, and
[`SECURITY.md`](SECURITY.md) for reporting a vulnerability. Licensed under
[Apache-2.0](LICENSE).
