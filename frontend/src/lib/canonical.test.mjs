import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { canonicalJson, parseJsonOrText } from "./canonical.ts";

// These vectors must remain byte-for-byte identical to the backend and
// reexecutor-agent canonical JSON implementations (CONTRIBUTING.md).
const vectors = [
  ["undefined", undefined, "null"],
  ["null", null, "null"],
  ["NaN", NaN, "null"],
  ["Infinity", Infinity, "null"],
  ["negative zero", -0, "0"],
  [
    "recursively nested object, array and undefined property",
    { b: 1, a: { d: 2, c: [3, { z: 1, y: undefined, x: null }] } },
    '{"a":{"c":[3,{"x":null,"z":1}],"d":2},"b":1}',
  ],
  [
    "numeric-looking keys and UTF-16 key ordering",
    { b: 1, a: 3, B: 2, "10": 1, "9": 2 },
    '{"10":1,"9":2,"B":2,"a":3,"b":1}',
  ],
  ["undefined array element becomes null", [undefined, 1, null], "[null,1,null]"],
  ["Unicode, newline and quotes inside a string", 'é \n"x"', '"é \\n\\"x\\""'],
  ["empty object", {}, "{}"],
  ["empty array", [], "[]"],
  ["undefined object properties are omitted", { a: undefined }, "{}"],
  ["non-ASCII keys sort after ASCII", { "é": 1, z: 2, a: 3 }, '{"a":3,"z":2,"é":1}'],
];

describe("canonicalJson golden vectors (#85)", () => {
  for (const [name, input, expected] of vectors) {
    it(name, () => {
      assert.equal(canonicalJson(input), expected);
    });
  }

  it("rejects a top-level BigInt instead of silently changing it", () => {
    assert.throws(() => canonicalJson(1n), TypeError);
  });

  it("rejects a nested BigInt", () => {
    assert.throws(() => canonicalJson({ a: 1n }), TypeError);
  });

  it("preserves canonical output when input key insertion order changes", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { z: 3, x: 2 } }),
      canonicalJson({ a: { x: 2, z: 3 }, b: 1 }),
    );
  });

  it("sorts keys recursively inside arrays and nested objects", () => {
    assert.equal(
      canonicalJson([{ z: { y: 1, x: 2 }, a: 4 }, { c: 3, b: [{ z: 8, a: 9 }] }]),
      '[{"a":4,"z":{"x":2,"y":1}},{"b":[{"a":9,"z":8}],"c":3}]',
    );
  });

  it("has no insignificant whitespace outside strings", () => {
    assert.equal(canonicalJson({ b: [1, 2], a: { d: 3 } }), '{"a":{"d":3},"b":[1,2]}');
    assert.equal(canonicalJson({ text: "keep  spaces" }), '{"text":"keep  spaces"}');
  });

  const hashVectors = [
    [
      '{"a":{"c":[3,{"x":null,"z":1}],"d":2},"b":1}',
      "c17610e9170edec56ed86af4e6e110091e79f42f7bc4460eb101ab613aeab138",
    ],
    [
      '{"10":1,"9":2,"B":2,"a":3,"b":1}',
      "99158e82efe4e49f542f73bbf83b8c783fa8fe10c452d680ca7a2e3eeb465e37",
    ],
  ];
  for (const [canonical, expectedHash] of hashVectors) {
    it("pins SHA-256 for " + canonical, () => {
      assert.equal(createHash("sha256").update(canonical, "utf8").digest("hex"), expectedHash);
    });
  }
});

describe("parseJsonOrText golden vectors (#85)", () => {
  const parsingVectors = [
    ["JSON object", '{"a":1}', { a: 1 }],
    ["JSON array", "[1, 2,3]", [1, 2, 3]],
    ["multiline JSON", '\n\t{"a": [1, 2]}\n', { a: [1, 2] }],
    ["number", "42", 42],
    ["boolean", "true", true],
    ["null", "null", null],
    ["quoted JSON string", '"quoted"', "quoted"],
    ["plain text with surrounding spaces", "  hello world  ", "hello world"],
    ["incomplete JSON", "[1,2", "[1,2"],
    ["single-quoted object", "{'a':1}", "{'a':1}"],
    ["undefined string", "undefined", "undefined"],
    ["leading-zero decimal text", "007", "007"],
    ["empty string", "", ""],
    ["whitespace-only string", "   ", ""],
  ];
  for (const [name, text, expected] of parsingVectors) {
    it(name, () => {
      assert.deepEqual(parseJsonOrText(text), expected);
    });
  }

  it("canonicalizes a parsed JSON object with sorted keys", () => {
    assert.equal(canonicalJson(parseJsonOrText('{"b":1,"a":2}')), '{"a":2,"b":1}');
  });

  it("canonicalizes plain text as a JSON string", () => {
    assert.equal(canonicalJson(parseJsonOrText("  hello  ")), '"hello"');
  });
});
