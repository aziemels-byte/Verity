import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bufFromHex,
  fromChainResolution,
  fromChainResolutionMethod,
  fromChainVerdict,
  hex,
  sha256Bytes,
  toChainTaskType,
} from "./mappers.js";

/**
 * Fieldless Soroban enums come from either the generated SDK client
 * ({tag, values: undefined}), raw scValToNative events ([tag]), or a string.
 * Exercise all three shapes: a former indexer bug accepted only objects.
 */
function enumRepresentations(tag: string): ReadonlyArray<{
  name: string;
  value: unknown;
}> {
  return [
    { name: "generated-client object", value: { tag, values: undefined } },
    { name: "raw event array", value: [tag] },
    { name: "bare tag string", value: tag },
  ];
}

describe("fromChainVerdict (#75)", () => {
  const cases = [
    ["Verified", "verified"],
    ["Disputed", "disputed"],
    ["Slashed", "slashed"],
    ["ExpiredUnverified", "expired_unverified"],
  ] as const;

  for (const [tag, expected] of cases) {
    for (const shape of enumRepresentations(tag)) {
      it(`${tag} as ${shape.name} becomes ${expected}`, () => {
        assert.equal(fromChainVerdict(shape.value), expected);
      });
    }
  }
});

describe("fromChainResolution (#75)", () => {
  const cases = [
    ["Upheld", "upheld"],
    ["Rejected", "rejected"],
    ["None", null],
  ] as const;

  for (const [tag, expected] of cases) {
    for (const shape of enumRepresentations(tag)) {
      it(`${tag} as ${shape.name} becomes ${String(expected)}`, () => {
        assert.equal(fromChainResolution(shape.value), expected);
      });
    }
  }
});

describe("fromChainResolutionMethod (#75)", () => {
  const cases = [
    ["ReexecutionConsensus", "reexecution_consensus"],
    ["WindowElapsed", "window_elapsed"],
    ["ZkProof", "zk_proof"],
    ["None", null],
  ] as const;

  for (const [tag, expected] of cases) {
    for (const shape of enumRepresentations(tag)) {
      it(`${tag} as ${shape.name} becomes ${String(expected)}`, () => {
        assert.equal(fromChainResolutionMethod(shape.value), expected);
      });
    }
  }
});

describe("toChainTaskType (#75)", () => {
  const cases = [
    ["deterministic", "Deterministic"],
    ["retrieval", "Retrieval"],
    ["unverifiable", "Unverifiable"],
  ] as const;

  for (const [input, tag] of cases) {
    it(`maps ${input} to the fieldless ${tag} contract variant`, () => {
      assert.deepEqual(toChainTaskType(input), { tag, values: undefined });
    });
  }
});

describe("SHA-256 and hash encoding (#75)", () => {
  const digests = [
    [
      "",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ],
    [
      "abc",
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ],
  ] as const;

  for (const [input, expected] of digests) {
    it(`produces the expected 32-byte digest for ${JSON.stringify(input)}`, () => {
      const digest = sha256Bytes(input);
      assert.equal(digest.byteLength, 32);
      assert.equal(hex(digest), expected);
      assert.deepEqual(sha256Bytes(Buffer.from(input, "utf8")), digest);
    });
  }

  it("round-trips an exact 32-byte lowercase hex hash through bufFromHex", () => {
    const encoded = "00ff10" + "00".repeat(29);
    assert.equal(encoded.length, 64);
    const decoded = bufFromHex(encoded);
    assert.equal(decoded.byteLength, 32);
    assert.equal(hex(decoded), encoded);
  });
});
