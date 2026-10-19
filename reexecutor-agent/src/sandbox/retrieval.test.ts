import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPrivateAddress,
  resolvePointer,
  resolvePublicTarget,
  runRetrieval,
} from "./retrieval.js";

describe("isPrivateAddress (#88)", () => {
  const blocked = [
    "10.0.0.1",
    "127.0.0.1",
    "0.0.0.0",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "FD00::1",
    "::FFFF:10.0.0.1",
  ];
  const publicAddresses = [
    "8.8.8.8",
    "1.1.1.1",
    "11.0.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.1.1",
    "169.253.1.1",
    "2001:4860:4860::8888",
    "2606:4700::1111",
  ];

  for (const ip of blocked) {
    it(`blocks ${ip}`, () => assert.equal(isPrivateAddress(ip), true));
  }
  for (const ip of publicAddresses) {
    it(`permits ${ip}`, () => assert.equal(isPrivateAddress(ip), false));
  }
});

describe("resolvePublicTarget with IP literals, without DNS (#88)", () => {
  it("rejects an invalid URL", async () => {
    await assert.rejects(
      resolvePublicTarget("not a url"),
      { message: "retrieval url is not a valid URL: not a url" },
    );
  });

  for (const [input, protocol] of [
    ["ftp://8.8.8.8/x", "ftp:"],
    ["file:///etc/hosts", "file:"],
  ]) {
    it(`rejects unsupported ${protocol} URLs`, async () => {
      await assert.rejects(
        resolvePublicTarget(input),
        { message: `unsupported retrieval protocol: ${protocol}` },
      );
    });
  }

  for (const [input, host] of [
    ["http://127.0.0.1/", "127.0.0.1"],
    ["http://[::1]/", "::1"],
    ["http://0x7f.0.0.1/", "127.0.0.1"],
    ["http://2130706433/", "127.0.0.1"],
    ["http://10.1.2.3/", "10.1.2.3"],
  ]) {
    it(`rejects the private literal ${input}`, async () => {
      await assert.rejects(
        resolvePublicTarget(input),
        {
          message: `retrieval target ${host} resolves to a non-public address`,
        },
      );
    });
  }

  it("accepts a public IPv4 literal without fetching", async () => {
    const target = await resolvePublicTarget("https://8.8.8.8/path?x=1");
    assert.equal(target.url.href, "https://8.8.8.8/path?x=1");
    assert.equal(target.address, "8.8.8.8");
    assert.equal(target.family, 4);
  });

  it("accepts a public IPv6 literal without fetching", async () => {
    const target = await resolvePublicTarget("http://[2001:4860:4860::8888]/");
    assert.equal(target.url.href, "http://[2001:4860:4860::8888]/");
    assert.equal(target.address, "2001:4860:4860::8888");
    assert.equal(target.family, 6);
  });
});

describe("resolvePointer (#88)", () => {
  it("returns the entire document for an empty pointer", () => {
    const doc = { a: 1 };
    assert.equal(resolvePointer(doc, ""), doc);
  });

  const cases: Array<{ doc: unknown; pointer: string; expected: unknown }> = [
    { doc: { a: { b: [10, 20] } }, pointer: "/a/b/1", expected: 20 },
    { doc: { "a/b": 1 }, pointer: "/a~1b", expected: 1 },
    { doc: { "m~n": 2 }, pointer: "/m~0n", expected: 2 },
    { doc: { "~1": 3 }, pointer: "/~01", expected: 3 },
    { doc: { "": 4 }, pointer: "/", expected: 4 },
  ];

  for (const { doc, pointer, expected } of cases) {
    it(`resolves ${pointer}`, () => {
      assert.deepEqual(resolvePointer(doc, pointer), expected);
    });
  }

  it("rejects a pointer without its leading slash", () => {
    assert.throws(() => resolvePointer({ a: 1 }, "a"), {
      message: "invalid JSON pointer: a",
    });
  });

  for (const [doc, pointer] of [
    [{ a: 1 }, "/missing"],
    [{ a: [10, 20] }, "/a/2"],
    [{ a: "leaf" }, "/a/child"],
    [{ a: null }, "/a/child"],
  ] as const) {
    it(`rejects a non-resolving path ${pointer}`, () => {
      assert.throws(() => resolvePointer(doc, pointer), {
        message: `JSON pointer ${pointer} does not resolve in the response`,
      });
    });
  }
});

describe("runRetrieval validates the spec before networking (#88)", () => {
  for (const [name, spec] of [
    ["missing spec", undefined],
    ["non-string url", { url: 5 }],
  ] as const) {
    it(`rejects a ${name}`, async () => {
      await assert.rejects(
        runRetrieval(spec as unknown as Parameters<typeof runRetrieval>[0]),
        {
          message:
            'retrieval input artifact must be JSON of the form {"url": "...", "pointer"?: "/..."}',
        },
      );
    });
  }
});
