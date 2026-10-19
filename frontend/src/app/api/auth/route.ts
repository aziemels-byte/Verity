import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL } from "../../../lib/config";
import { readJsonBody, SESSION_COOKIE } from "../../../lib/backend-proxy";

/**
 * Step 2 of SEP-10: the client has already signed the challenge with
 * Freighter. We forward the signed XDR to the real backend for verification
 * against the claimed account's actual on-chain signing key, then store the
 * returned JWT in an httpOnly cookie - never in localStorage, never handed
 * back to client JS - so an XSS bug can't exfiltrate the session token.
 */
export async function POST(req: NextRequest) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "The Verity backend is not reachable right now. Try again in a moment." }, { status: 502 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    return NextResponse.json({ error: data.error ?? "authentication failed" }, { status: res.status });
  }

  const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64url").toString("utf8"));
  const remaining = typeof payload.exp === "number" ? Math.floor(payload.exp - Date.now() / 1000) : undefined;
  if (remaining !== undefined && remaining <= 0) {
    return NextResponse.json({ error: "The backend issued a token that has already expired." }, { status: 502 });
  }
  const response = NextResponse.json({ account: payload.sub });
  response.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    // Production requires HTTPS: on plain HTTP, browsers reject the Secure
    // session cookie even if login returns 200 (docs/DEPLOY.md, section 4).
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(remaining === undefined ? {} : { maxAge: remaining }),
  });
  return response;
}
