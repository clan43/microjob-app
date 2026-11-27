import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import User from "@/models/User";
import Subscription from "@/models/Subscription";
import GenerationLog from "@/models/GenerationLog";
import { requireAdmin } from "../_lib/adminAuth";
import { syncPendingPipraPayOrder } from "@/app/api/payment/_lib/piprapay";
import { getUserAccessEnds } from "@/app/api/_lib/subscriptionStacking";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await requireAdmin(request);
  if (authorization.response) return authorization.response;

  try {
    await connectDB();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    const status = url.searchParams.get("status") || "all";
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20));
    const now = new Date();
    const filter: Record<string, any> = {};

    if (status === "active") {
      Object.assign(filter, { paymentStatus: "COMPLETED", accessStatus: "ACTIVE", expiresAt: { $gt: now } });
    } else if (/^expiring(-\d+)?$/.test(status)) {
      // "expiring" = next 7 days, "expiring-1" = last day (24h), "expiring-3" = next 3 days.
      const days = status === "expiring" ? 7 : Math.min(30, Math.max(1, Number(status.split("-")[1]) || 7));
      Object.assign(filter, {
        paymentStatus: "COMPLETED",
        accessStatus: "ACTIVE",
        expiresAt: { $gt: now, $lte: new Date(now.getTime() + days * 86_400_000) },
      });
    } else if (status === "expired") {
      filter.$or = [{ accessStatus: "EXPIRED" }, { expiresAt: { $lte: now } }];
    } else if (status === "pending") {
      filter.paymentStatus = "PENDING";
    } else if (status === "cancelled") {
      filter.$or = [{ paymentStatus: "CANCELLED" }, { accessStatus: "CANCELLED" }];
    } else if (status === "error") {
      filter.paymentStatus = "ERROR";
    } else if (status === "rejected") {
      filter.paymentStatus = "REJECTED";
    }

    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      const matchingUsers = await User.find({ $or: [{ fullName: regex }, { email: regex }, { phoneNumber: regex }] }).select("_id").lean();
      const ids = matchingUsers.map((user: any) => user._id);
      const userIdClause = { userId: { $in: ids } };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, userIdClause];
        delete filter.$or;
      } else {
        filter.userId = { $in: ids };
      }
    }

    // Refresh recent pending PipraPay orders first so their TrxID / sender number appear for manual
    // approval, and abandoned checkouts (no TrxID after 20 min) show as Cancelled instead of Pending.
    if (status === "pending" || status === "all" || status === "cancelled") {
      const pendingPipra = await Subscription.find({
        paymentProvider: "PipraPay", paymentStatus: "PENDING", accessStatus: "PENDING",
        createdAt: { $gt: new Date(now.getTime() - 7 * 86_400_000) },
      }).sort({ createdAt: -1 }).limit(15).select("_id").lean();
      await Promise.allSettled(pendingPipra.map((row: any) => syncPendingPipraPayOrder(String(row._id), { staleAfterMinutes: 20 })));
    }

    const isExpiringView = status.startsWith("expiring");
    const populateUser = { path: "userId", select: "fullName email phoneNumber" };
    let total = 0;
    let itemsRaw: any[] = [];
    // userId -> the date this customer's TOTAL paid access ends (all stacked plans + manual access).
    let accessEnds = new Map<string, Date>();

    if (isExpiringView) {
      // Renewal watch works per customer, not per record: someone who already bought another plan
      // (or has manual access) that runs past this one is not "ending soon", so leave them out.
      const candidates: any[] = await Subscription.find(filter)
        .sort({ expiresAt: 1 })
        .populate(populateUser)
        .lean();
      const candidateUserIds = Array.from(
        new Set(candidates.map((item) => String(item.userId && typeof item.userId === "object" ? item.userId._id : item.userId)).filter(Boolean)),
      );
      accessEnds = await getUserAccessEnds(candidateUserIds, now);
      const stillEnding = candidates.filter((item) => {
        const uid = String(item.userId && typeof item.userId === "object" ? item.userId._id : item.userId);
        const end = accessEnds.get(uid);
        return !end || end.getTime() <= new Date(item.expiresAt).getTime();
      });
      total = stillEnding.length;
      itemsRaw = stillEnding.slice((page - 1) * limit, page * limit);
    } else {
      const [count, rows] = await Promise.all([
        Subscription.countDocuments(filter),
        Subscription.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate(populateUser)
          .lean(),
      ]);
      total = count;
      itemsRaw = rows as any[];
      const pageUserIds = Array.from(
        new Set(itemsRaw.map((item) => String(item.userId && typeof item.userId === "object" ? item.userId._id : item.userId)).filter(Boolean)),
      );
      accessEnds = await getUserAccessEnds(pageUserIds, now);
    }

    // Images generated by each paid subscriber during their paid period (successful generations only).
    const imageCounts = await Promise.all(
      itemsRaw.map(async (item: any) => {
        const uid = item.userId && typeof item.userId === "object" ? item.userId._id : item.userId;
        if (!uid || item.paymentStatus !== "COMPLETED" || !item.startedAt) return null;
        try {
          const end = item.expiresAt && new Date(item.expiresAt) < now ? new Date(item.expiresAt) : now;
          return await GenerationLog.countDocuments({
            userId: uid,
            outcome: "allowed",
            success: { $ne: false },
            createdAt: { $gte: new Date(item.startedAt), $lte: end },
          });
        } catch {
          return null;
        }
      }),
    );

    const subscriptions = itemsRaw.map((item: any, index: number) => {
      const uid = String(item.userId && typeof item.userId === "object" ? item.userId._id : item.userId);
      const startedMs = item.startedAt ? new Date(item.startedAt).getTime() : NaN;
      const expiresMs = item.expiresAt ? new Date(item.expiresAt).getTime() : NaN;
      // The real purchase moment (startedAt can be in the future when the plan is stacked).
      const purchasedAt = item.submittedAt || item.createdAt || item.startedAt || null;
      // Days carried over = how far the start was pushed beyond the moment the plan was activated.
      const activatedAt = item.reviewedAt || item.createdAt || purchasedAt;
      const activatedMs = activatedAt ? new Date(activatedAt).getTime() : NaN;
      const isRunning = item.paymentStatus === "COMPLETED" && item.accessStatus === "ACTIVE" && expiresMs > now.getTime();
      // Queued: bought already, but starts later because an earlier plan is still running.
      const isQueued = isRunning && startedMs > now.getTime();
      const carriedOverDays =
        isRunning && Number.isFinite(startedMs) && Number.isFinite(activatedMs) && startedMs - activatedMs > 3_600_000
          ? Math.ceil((startedMs - activatedMs) / 86_400_000)
          : 0;
      const accessEnd = isRunning ? accessEnds.get(uid) || null : null;
      // Renewed: this plan ends, but the customer's access continues on a later plan.
      const isRenewed = Boolean(accessEnd && accessEnd.getTime() > expiresMs + 60_000);
      return {
      id: String(item._id),
      planId: item.planId,
      planName: item.planName,
      months: Number(item.months || 0),
      planDays: Number(item.planDays || 0),
      amount: Number(item.amount || 0),
      invoiceId: item.invoiceId || item.providerInvoiceId || "",
      paymentProvider: item.paymentProvider || "",
      transactionId: item.transactionId || "",
      paymentMethod: item.paymentMethod || "",
      senderNumber: item.senderNumber || "",
      reviewStatus: item.reviewStatus || (item.paymentStatus === "COMPLETED" ? "APPROVED" : item.paymentStatus === "REJECTED" ? "REJECTED" : "PENDING"),
      submittedAt: item.submittedAt || null,
      reviewedAt: item.reviewedAt || null,
      reviewedBy: item.reviewedBy || "",
      reviewNote: item.reviewNote || "",
      paymentStatus: item.paymentStatus,
      accessStatus: item.accessStatus,
      startedAt: item.startedAt || null,
      purchasedAt,
      isQueued,
      carriedOverDays,
      isRenewed,
      accessEndsAt: accessEnd ? accessEnd.toISOString() : null,
      imagesGenerated: imageCounts[index],
      reminderSentAt: item.expiryWarningSentAt || null,
      expiresAt: item.expiresAt || null,
      createdAt: item.createdAt || null,
      user: item.userId && typeof item.userId === "object"
        ? {
            id: String(item.userId._id),
            fullName: item.userId.fullName || "Unknown user",
            email: item.userId.email || "",
            phoneNumber: item.userId.phoneNumber || "",
          }
        : null,
      };
    });

    return NextResponse.json(
      { success: true, subscriptions, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Admin subscription list error:", error);
    return NextResponse.json(
      { success: false, message: "Could not load the subscription list." },
      { status: 500 },
    );
  }
}
