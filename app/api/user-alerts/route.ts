import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getVerifiedRequestSession } from "@/lib/serverAuth";
import User from "@/models/User";
import Subscription from "@/models/Subscription";
import UserAlert from "@/models/UserAlert";
import UserAlertReceipt from "@/models/UserAlertReceipt";
import { ALERT_WIDTH_PX, renderAlertHtml, type AlertWidth } from "@/app/_lib/userAlertRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" };
const NOTHING = { show: false };

/** "Today" in Bangladesh time, used by alerts that repeat every day. */
function todayKey(): string {
  return new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function firstNameOf(fullName: string) {
  const name = fullName.trim();
  return name ? name.split(/\s+/)[0] : "";
}

/**
 * GET: the next popup this user should see (or { show: false }).
 * An alert is shown when it is active, inside its time window, the user is in its audience, and
 *   once  -> the user has not closed it yet
 *   daily -> the user has not closed it today
 */
export async function GET(request: Request) {
  const session = await getVerifiedRequestSession(request);
  if (!session) return NextResponse.json(NOTHING, { status: 401, headers: NO_STORE });
  // Admin accounts (and the env admin) never get user popups; banned users are skipped too.
  if (session.role === "admin" || session.isBanned || !mongoose.isValidObjectId(session.userId)) {
    return NextResponse.json(NOTHING, { headers: NO_STORE });
  }

  try {
    await connectDB();
    const now = new Date();
    const userId = new mongoose.Types.ObjectId(session.userId);

    const candidates: any[] = await UserAlert.find({
      active: true,
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      ],
    })
      .sort({ priority: -1, createdAt: 1 })
      .limit(30)
      .lean();
    if (candidates.length === 0) return NextResponse.json(NOTHING, { headers: NO_STORE });

    const receipts: any[] = await UserAlertReceipt.find({
      userId,
      alertId: { $in: candidates.map((c) => c._id) },
    }).lean();
    const receiptByAlert = new Map(receipts.map((r) => [String(r.alertId), r]));
    const today = todayKey();

    let subscribed: boolean | null = null;
    const isSubscribed = async () => {
      if (subscribed === null) {
        subscribed = Boolean(
          await Subscription.exists({
            userId,
            paymentStatus: "COMPLETED",
            accessStatus: "ACTIVE",
            expiresAt: { $gt: now },
          }),
        );
      }
      return subscribed;
    };

    for (const alert of candidates) {
      const receipt = receiptByAlert.get(String(alert._id));
      if (alert.repeat === "daily") {
        if (receipt?.lastDismissDay === today) continue;
      } else if (receipt?.dismissedAt) {
        continue;
      }

      if (alert.audience === "specific") {
        if (!(alert.targetUserIds || []).some((id: any) => String(id) === session.userId)) continue;
      } else if (alert.audience === "subscribed") {
        if (!(await isSubscribed())) continue;
      } else if (alert.audience === "not_subscribed") {
        if (await isSubscribed()) continue;
      }

      const user: any = await User.findById(userId).select("fullName email").lean();
      const fullName = String(user?.fullName || "");
      const html = renderAlertHtml(alert, {
        name: fullName,
        firstName: firstNameOf(fullName),
        email: String(user?.email || ""),
      });
      const width = (["sm", "md", "lg"].includes(alert.width) ? alert.width : "md") as AlertWidth;
      return NextResponse.json(
        { show: true, id: String(alert._id), html, width: ALERT_WIDTH_PX[width] },
        { headers: NO_STORE },
      );
    }
    return NextResponse.json(NOTHING, { headers: NO_STORE });
  } catch (error) {
    console.error("User alert lookup failed:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json(NOTHING, { status: 500, headers: NO_STORE });
  }
}

/** POST { id, action: "shown" | "dismiss" | "click" } records what this user did with the popup. */
export async function POST(request: Request) {
  const session = await getVerifiedRequestSession(request);
  if (!session) return NextResponse.json({ success: false }, { status: 401, headers: NO_STORE });
  if (session.role === "admin" || !mongoose.isValidObjectId(session.userId)) {
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  }
  // An admin who is "logging in as" a user must not mark the popup as seen for the real user.
  if ((session.claims as { impersonation?: unknown }).impersonation === true) {
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  }

  const body = await request.json().catch(() => null);
  const id = body && typeof body.id === "string" ? body.id : "";
  const action = body?.action;
  if (!mongoose.isValidObjectId(id) || !["shown", "dismiss", "click"].includes(action)) {
    return NextResponse.json({ success: false }, { status: 400, headers: NO_STORE });
  }

  try {
    await connectDB();
    if (!(await UserAlert.exists({ _id: id }))) return NextResponse.json({ success: true }, { headers: NO_STORE });

    const now = new Date();
    const today = todayKey();
    const filter = { alertId: id, userId: session.userId };

    if (action === "shown") {
      await UserAlertReceipt.updateOne(
        filter,
        { $inc: { shownCount: 1 }, $set: { lastShownDay: today }, $setOnInsert: { firstShownAt: now } },
        { upsert: true },
      );
    } else {
      const set: Record<string, unknown> = { dismissedAt: now, lastDismissDay: today };
      if (action === "click") set.clickedAt = now;
      await UserAlertReceipt.updateOne(
        filter,
        { $set: set, $setOnInsert: { firstShownAt: now } },
        { upsert: true },
      );
    }
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (error) {
    console.error("User alert receipt failed:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ success: false }, { status: 500, headers: NO_STORE });
  }
}
