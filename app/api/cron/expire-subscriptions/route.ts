import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { connectDB } from "@/lib/db";
import Subscription from "@/models/Subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Marks paid subscriptions whose time has run out as EXPIRED.
 *
 * Access was never at risk: every paid-tool check already requires
 * `expiresAt > now`. This only keeps the stored status honest so reports and
 * the admin panel match what users actually have.
 *
 * Auth: same as cleanup-files - `Authorization: Bearer <CRON_SECRET>`.
 */
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return { ok: false as const, status: 503, error: "CRON_SECRET is not configured." };

  const header = request.headers.get("authorization") || "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  const match = expected.length === received.length && timingSafeEqual(expected, received);
  return match ? { ok: true as const } : { ok: false as const, status: 401, error: "Unauthorized." };
}

export async function GET(request: Request) {
  const auth = isAuthorized(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  }

  try {
    await connectDB();
    const result = await Subscription.updateMany(
      { paymentStatus: "COMPLETED", accessStatus: "ACTIVE", expiresAt: { $ne: null, $lte: new Date() } },
      { $set: { accessStatus: "EXPIRED" } },
    );
    const expired = Number(result.modifiedCount || 0);
    console.info("[cron/expire-subscriptions]", JSON.stringify({ expired }));
    return NextResponse.json({ success: true, expired });
  } catch (error) {
    console.error("[cron/expire-subscriptions] failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Expire job failed." },
      { status: 500 },
    );
  }
}
