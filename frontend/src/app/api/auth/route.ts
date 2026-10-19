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
  const incomingAddress = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip");
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(incomingAddress ? { "x-forwarded-for": incomingAddress } : {}) },
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
  const response = NextResponse.json({ account: payload.sub });
  response.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
  return response;
}
