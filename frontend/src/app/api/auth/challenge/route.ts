import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL } from "../../../../lib/config";

export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get("account");
  if (!account) {
    return NextResponse.json({ error: "account query param required" }, { status: 400 });
  }
  const incomingAddress = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip");
  try {
    const res = await fetch(
      `${BACKEND_URL}/auth?account=${encodeURIComponent(account)}`,
      { cache: "no-store", ...(incomingAddress ? { headers: { "x-forwarded-for": incomingAddress } } : {}) }
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "The Verity backend is not reachable right now. Try again in a moment." }, { status: 502 });
  }
}
