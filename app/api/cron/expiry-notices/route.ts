import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { connectDB } from "@/lib/db";
import Subscription from "@/models/Subscription";
import User from "@/models/User";
import { sendTransactionalEmail } from "@/app/api/_lib/emailDelivery";
import { renderSubscriptionExpiryEmail } from "@/app/api/_lib/emailTemplates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Premium expiry e-mails for paid subscriptions:
 *   - a reminder when 3 days or less are left (once per subscription)
 *   - a "your access ended" notice after the time ran out (once, within 3 days of the end)
 *
 * A subscription is claimed (the "sent" time is stored) BEFORE mailing, so two overlapping runs can
 * never mail the same person twice. If delivery fails for a temporary reason the claim is released
 * and the next run tries again. Users who already renewed (a later paid plan or admin access exists)
 * are skipped. Auth: `Authorization: Bearer <CRON_SECRET>`, same as the other cron routes.
 */
const DAY = 24 * 60 * 60 * 1000;
const WARN_DAYS = 3;
const EXPIRED_WINDOW_DAYS = 3;
const MAX_PER_RUN = 40;
const MAX_MS = 50_000;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return { ok: false as const, status: 503, error: "CRON_SECRET is not configured." };

  const header = request.headers.get("authorization") || "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  const match = expected.length === received.length && timingSafeEqual(expected, received);
  return match ? { ok: true as const } : { ok: false as const, status: 401, error: "Unauthorized." };
}

async function hasLaterAccess(userId: unknown, endsAt: Date, user: any) {
  const manualEnd = user?.manualAccessEnabled === true && user?.manualAccessExpiresAt
    ? new Date(user.manualAccessExpiresAt).getTime()
    : 0;
  if (manualEnd > endsAt.getTime()) return true;
  const later = await Subscription.exists({
    userId,
    paymentStatus: "COMPLETED",
    accessStatus: "ACTIVE",
    expiresAt: { $gt: endsAt },
  });
  return Boolean(later);
}

type Counters = { warned: number; expiredNotices: number; skipped: number; failed: number };

async function processOne(kind: "warning" | "expired", field: "expiryWarningSentAt" | "expiredNoticeSentAt", filter: Record<string, unknown>, counters: Counters) {
  // Claim one subscription atomically.
  const claimed: any = await Subscription.findOneAndUpdate(
    { ...filter, [field]: null },
    { $set: { [field]: new Date() } },
    { new: true, sort: { expiresAt: 1 } },
  ).lean();
  if (!claimed) return false;

  const release = () => Subscription.updateOne({ _id: claimed._id }, { $set: { [field]: null } }).catch(() => undefined);

  try {
    const user: any = await User.findById(claimed.userId)
      .select("fullName email role isBanned manualAccessEnabled manualAccessExpiresAt")
      .lean();
    const endsAt = new Date(claimed.expiresAt);
    if (!user || !user.email || user.isBanned === true || user.role === "admin" || (await hasLaterAccess(claimed.userId, endsAt, user))) {
      counters.skipped += 1; // claim stays: nothing to send for this one
      return true;
    }

    const daysLeft = Math.max(1, Math.ceil((endsAt.getTime() - Date.now()) / DAY));
    const mail = renderSubscriptionExpiryEmail({
      kind,
      name: user.fullName,
      planName: claimed.planName,
      expiresAt: endsAt,
      daysLeft,
    });
    await sendTransactionalEmail({ to: String(user.email), subject: mail.subject, html: mail.html, text: mail.text });
    if (kind === "warning") counters.warned += 1;
    else counters.expiredNotices += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    counters.failed += 1;
    console.error(`[cron/expiry-notices] ${kind} mail failed:`, message.slice(0, 200));
    // A bad address will never work: keep the claim. Any other failure: try again next run.
    if (!/Invalid recipient/i.test(message)) await release();
  }
  return true;
}

export async function GET(request: Request) {
  const auth = isAuthorized(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  }

  try {
    await connectDB();
    const started = Date.now();
    const counters: Counters = { warned: 0, expiredNotices: 0, skipped: 0, failed: 0 };
    const now = new Date();

    const warnFilter = {
      paymentStatus: "COMPLETED",
      accessStatus: "ACTIVE",
      expiresAt: { $gt: now, $lte: new Date(now.getTime() + WARN_DAYS * DAY) },
    };
    const expiredFilter = {
      paymentStatus: "COMPLETED",
      accessStatus: { $in: ["ACTIVE", "EXPIRED"] },
      expiresAt: { $lte: now, $gte: new Date(now.getTime() - EXPIRED_WINDOW_DAYS * DAY) },
    };

    let handled = 0;
    while (handled < MAX_PER_RUN && Date.now() - started < MAX_MS) {
      if (!(await processOne("warning", "expiryWarningSentAt", warnFilter, counters))) break;
      handled += 1;
    }
    while (handled < MAX_PER_RUN && Date.now() - started < MAX_MS) {
      if (!(await processOne("expired", "expiredNoticeSentAt", expiredFilter, counters))) break;
      handled += 1;
    }

    console.info("[cron/expiry-notices]", JSON.stringify(counters));
    return NextResponse.json({ success: true, ...counters });
  } catch (error) {
    console.error("[cron/expiry-notices] failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Notice job failed." },
      { status: 500 },
    );
  }
}
