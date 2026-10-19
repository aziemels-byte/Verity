import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReplayInfrastructureError,
  runDeterministicFunction,
} from "./runner.js";

// The worker has its own 20 s host timeout. A test should time out sooner
// if sandbox resource limits stop working instead of waiting indefinitely.
const CASE_TIMEOUT_MS = 15_000;

async function expectGuestError(source: string, message: RegExp): Promise<void> {
  await assert.rejects(
    runDeterministicFunction(source, {}),
    (error: unknown) => {
      assert.ok(error instanceof Error, "sandbox must reject with an Error");
      assert.ok(
        !(error instanceof ReplayInfrastructureError),
        "a guest failure must never be mistaken for a host failure",
      );
      assert.match(error.message, message);
      return true;
    },
  );
}

describe("isolated deterministic replay sandbox (#89)", () => {
  it("returns a canonical SHA-256 hash and the expected engine", { timeout: CASE_TIMEOUT_MS }, async () => {
    const result = await runDeterministicFunction("return { doubled: input.n * 2 };", { n: 21 });
    assert.deepEqual(result.output, { doubled: 42 });
    assert.equal(
      result.outputHash,
      "27d4958085af3032ba46babb9e0b71690f9e2cc745ff7bb403a3d54e12152f82",
    );
    assert.match(result.engine, /^quickjs-emscripten@/);
  });

  it("has no clock", { timeout: CASE_TIMEOUT_MS }, async () => {
    const result = await runDeterministicFunction("return typeof Date;", {});
    assert.equal(result.output, "undefined");
  });

  it("rejects attempts to use Date", { timeout: CASE_TIMEOUT_MS }, async () => {
    await expectGuestError("return new Date();", /Date/);
  });

  it("has no Math.random", { timeout: CASE_TIMEOUT_MS }, async () => {
    const result = await runDeterministicFunction("return typeof Math.random;", {});
    assert.equal(result.output, "undefined");
  });

  it("enforces the computation budget on a tight loop", { timeout: CASE_TIMEOUT_MS }, async () => {
    await expectGuestError("while (true) {}", /computation budget exceeded/);
  });

  it("enforces the guest memory limit", { timeout: CASE_TIMEOUT_MS }, async () => {
    await expectGuestError("const s = 'x'.repeat(70*1024*1024); return s.length;", /out of memory/i);
  });

  it("enforces the guest stack limit", { timeout: CASE_TIMEOUT_MS }, async () => {
    await expectGuestError("function f(){ return f() + 1; } return f();", /stack overflow/i);
  });

  it("rejects serialized output larger than one million bytes", { timeout: CASE_TIMEOUT_MS }, async () => {
    await expectGuestError("return 'x'.repeat(1100000);", /larger than 1000000 bytes/);
  });

  it("serializes undefined return values and empty bodies as JSON null", { timeout: CASE_TIMEOUT_MS }, async () => {
    for (const source of ["return undefined;", ""]) {
      const result = await runDeterministicFunction(source, {});
      assert.equal(result.output, null);
      assert.equal(
        result.outputHash,
        "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
      );
    }
  });

  it("has no host process, require, fetch, timeout or Buffer globals", { timeout: CASE_TIMEOUT_MS }, async () => {
    const result = await runDeterministicFunction(
      "return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer];",
      {},
    );
    assert.deepEqual(result.output, [
      "undefined", "undefined", "undefined", "undefined", "undefined",
    ]);
  });

  it("treats a guest throw as a guest failure, not infrastructure failure", { timeout: CASE_TIMEOUT_MS }, async () => {
    await expectGuestError("throw new Error('boom');", /Error: boom/);
  });

  it("treats malformed guest JavaScript as a guest failure", { timeout: CASE_TIMEOUT_MS }, async () => {
    await expectGuestError("return (;", /SyntaxError/);
  });

  it("serializes a returned function as null", { timeout: CASE_TIMEOUT_MS }, async () => {
    const result = await runDeterministicFunction("return () => 1;", {});
    assert.equal(result.output, null);
  });

  it("uses normal JSON.stringify rules for NaN and undefined", { timeout: CASE_TIMEOUT_MS }, async () => {
    const result = await runDeterministicFunction(
      "return {a: NaN, b: undefined, c: [undefined]};",
      {},
    );
    assert.deepEqual(result.output, { a: null, c: [null] });
  });

  it("does not leak previous guest globals or prototype modifications", { timeout: CASE_TIMEOUT_MS }, async () => {
    const first = await runDeterministicFunction(
      "globalThis.leak = 1; Array.prototype.foo = 1; return 1;",
      {},
    );
    assert.equal(first.output, 1);
    const second = await runDeterministicFunction(
      "return [typeof globalThis.leak, typeof [].foo];",
      {},
    );
    assert.deepEqual(second.output, ["undefined", "undefined"]);
  });
});
