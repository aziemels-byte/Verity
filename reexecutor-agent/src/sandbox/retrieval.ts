import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { canonicalHash } from "./canonical.js";

/**
 * The input artifact of a retrieval task: the request the agent claims to
 * have made. A re-executor re-issues exactly this request and compares the
 * (optionally JSON-pointer-extracted) result with the agent's claimed output.
 */
export interface RetrievalSpec {
  url: string;
  /** RFC 6901 JSON pointer into a JSON response body, e.g. "/data/0/price". */
  pointer?: string;
}

const MAX_BODY_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;

/**
 * The target could not be reached, or answered in a way that says "try
 * again" (5xx, 408, 429). That may be the target, or it may be this host's
 * network — and a vote is irreversible — so the caller retries for a while
 * and then checks its own connectivity before concluding anything.
 */
export class RetrievalTransientError extends Error {}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

interface PinnedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** A retrieval spec is attacker-controlled input: without this, any agent
 * could point re-executors at their operator's internal network (cloud
 * metadata endpoints, localhost admin ports) and read the result back.
 *
 * Returns the one address that was checked. The request is then made to
 * exactly that address, so the name cannot resolve somewhere else between
 * the check and the connection. */
async export function resolvePublicTarget(raw: string): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`retrieval url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`unsupported retrieval protocol: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // The name does not exist: that is an answer. Anything else (timeout,
      // server failure) is the resolver, not the target.
      if (code === "ENOTFOUND") throw new Error(`retrieval host ${host} does not exist`);
      throw new RetrievalTransientError(`could not resolve ${host}: ${code ?? (err as Error).message}`);
    }
  }
  if (addresses.length === 0) throw new Error(`retrieval host ${host} has no address`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`retrieval target ${host} resolves to a non-public address`);
  }
  // IPv4 first: plenty of hosts have no IPv6 route.
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0];
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/** One GET to the pinned address, never following redirects. Resolves with
 * any HTTP response; rejects with RetrievalTransientError when no response
 * could be obtained. */
function getPinned(target: PinnedTarget): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const req = transport.get(
      target.url,
      {
        headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
        timeout: TIMEOUT_MS,
        // Connect to the address that was vetted, whatever DNS says now.
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            (callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [
              { address: target.address, family: target.family },
            ]);
          } else {
            (callback as (err: null, address: string, family: number) => void)(null, target.address, target.family);
          }
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            reject(new Error("retrieval response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => reject(new RetrievalTransientError(`response interrupted: ${err.message}`)));
      }
    );
    req.on("timeout", () => req.destroy(new RetrievalTransientError(`no response within ${TIMEOUT_MS / 1000}s`)));
    req.on("error", (err) =>
      reject(err instanceof RetrievalTransientError ? err : new RetrievalTransientError(`request failed: ${err.message}`))
    );
  });
}

export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer: ${pointer}`);
  let node: any = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(key in node)) {
      throw new Error(`JSON pointer ${pointer} does not resolve in the response`);
    }
    node = node[key];
  }
  return node;
}

/**
 * Re-issues the declared request. Throws a plain Error for an outcome that
 * settles the question against the submission (bad spec, private target,
 * redirect, 4xx, oversize, pointer that does not resolve), and a
 * RetrievalTransientError for one that does not.
 */
export async function runRetrieval(spec: RetrievalSpec): Promise<{ outputHash: string; output: unknown; engine: string }> {
  if (!spec || typeof spec.url !== "string") {
    throw new Error('retrieval input artifact must be JSON of the form {"url": "...", "pointer"?: "/..."}');
  }
  const target = await resolvePublicTarget(spec.url);
  const res = await getPinned(target);
  // A redirect could bounce to a private address, and a moved resource is a
  // legitimate mismatch anyway: the agent declared this URL, not another.
  if (res.status >= 300 && res.status < 400) throw new Error(`retrieval target redirected (HTTP ${res.status})`);
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new RetrievalTransientError(`retrieval target answered HTTP ${res.status}`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`retrieval target answered HTTP ${res.status}`);

  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    if (spec.pointer) throw new Error("a JSON pointer was given but the response is not JSON");
  }
  const output = spec.pointer !== undefined ? resolvePointer(body, spec.pointer) : body;
  return { outputHash: canonicalHash(output), output, engine: "http-refetch (public egress only, address pinned)" };
}

/** True if this host can reach the public internet at all: any HTTP answer
 * from a known-good endpoint counts. Used before blaming a target for being
 * unreachable. */
export async function hasConnectivity(controlUrl: string): Promise<boolean> {
  try {
    await getPinned(await resolvePublicTarget(controlUrl));
    return true;
  } catch {
    return false;
  }
}
