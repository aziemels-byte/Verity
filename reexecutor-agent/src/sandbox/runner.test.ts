import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayInfrastructureError, runDeterministicFunction } from "./runner.js";

const opts = { timeout: 15_000 };
const nullHash = "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";

async function guestError(source: string, pattern: RegExp) {
  await assert.rejects(runDeterministicFunction(source, {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof ReplayInfrastructureError), "guest failure is not a host failure");
    assert.match(error.message, pattern);
    return true;
  });
}

test("deterministic replay returns correct canonical hash and engine", opts, async () => {
  const result = await runDeterministicFunction("return { doubled: input.n * 2 };", { n: 21 });
  assert.deepEqual(result.output, { doubled: 42 });
  assert.equal(result.outputHash, "27d4958085af3032ba46babb9e0b71690f9e2cc745ff7bb403a3d54e12152f82");
  assert.match(result.engine, /^quickjs-emscripten@/);
});

test("Date and Math.random are unavailable", opts, async () => {
  assert.equal((await runDeterministicFunction("return typeof Date;", {})).output, "undefined");
  assert.equal((await runDeterministicFunction("return typeof Math.random;", {})).output, "undefined");
});
test("using Date is a guest error", opts, async () => guestError("return new Date();", /Date/));
test("infinite loops exhaust compute ticks", opts, async () => guestError("while (true) {}", /computation budget exceeded/));
test("memory allocations hit the guest memory limit", opts, async () => guestError("const s = 'x'.repeat(70*1024*1024); return s.length;", /out of memory/i));
test("recursion hits the guest stack limit", opts, async () => guestError("function f(){ return f() + 1; } return f();", /stack overflow/i));
test("oversized output fails without a host error", opts, async () => guestError("return 'x'.repeat(1100000);", /larger than 1000000 bytes/));

test("undefined and an empty function serialize as null", opts, async () => {
  for (const source of ["return undefined;", ""]) {
    const result = await runDeterministicFunction(source, {});
    assert.equal(result.output, null);
    assert.equal(result.outputHash, nullHash);
  }
});

test("Node globals are absent", opts, async () => {
  const result = await runDeterministicFunction("return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer];", {});
  assert.deepEqual(result.output, Array(5).fill("undefined"));
});
test("guest throw returns plain error", opts, async () => guestError("throw new Error('boom');", /Error: boom/));
test("syntax error is a guest error", opts, async () => guestError("return (;", /SyntaxError/));
test("non-JSON return values become null", opts, async () => {
  const result = await runDeterministicFunction("return () => 1;", {});
  assert.equal(result.output, null);
  assert.equal(result.outputHash, nullHash);
});
test("JSON serialization normalizes NaN and undefined", opts, async () => {
  const result = await runDeterministicFunction("return {a: NaN, b: undefined, c: [undefined]};", {});
  assert.deepEqual(result.output, { a: null, c: [null] });
});
test("each replay starts with isolated globals and prototypes", opts, async () => {
  await runDeterministicFunction("globalThis.leak = 1; Array.prototype.foo = 1; return 1;", {});
  const result = await runDeterministicFunction("return [typeof globalThis.leak, typeof [].foo];", {});
  assert.deepEqual(result.output, ["undefined", "undefined"]);
});
