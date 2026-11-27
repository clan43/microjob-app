import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import User from "@/models/User";
import Subscription from "@/models/Subscription";
import Withdrawal from "@/app/api/_lib/Withdrawal";
import { PRESENCE_STALE_AFTER_MS } from "@/lib/presenceConstants";
import { getAdminCredentials } from "@/lib/adminCredentials";
import { requireAdmin } from "../_lib/adminAuth";
import { buildInsights } from "./_insights";
import { getUserAccessEnds } from "@/app/api/_lib/subscriptionStacking";

/**
 * Customers whose TOTAL paid access (all stacked plans + manual access) ends soon.
 * Counted per customer, so someone who already bought a longer plan after this one is not "ending".
 */
async function countExpiringCustomers(now: Date) {
  const day = 86_400_000;
  const weekEnd = new Date(now.getTime() + 7 * day);
  const rows = await Subscription.aggregate([
    { $match: { paymentStatus: "COMPLETED", accessStatus: "ACTIVE", expiresAt: { $gt: now } } },
    { $group: { _id: "$userId", end: { $max: "$expiresAt" } } },
    { $match: { end: { $lte: weekEnd } } },
  ]);
  const ends = await getUserAccessEnds(rows.map((row: any) => row._id), now);
  let week = 0;
  let three = 0;
  let oneDay = 0;
  for (const end of ends.values()) {
    const left = end.getTime() - now.getTime();
    if (left <= 0 || left > 7 * day) continue;
    week += 1;
    if (left <= 3 * day) three += 1;
    if (left <= day) oneDay += 1;
  }
  return { week, three, day: oneDay };
}

export const dynamic = "force-dynamic";

function dayKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Very short in-memory cache (per server instance) used only for background polling
// (?cached=1). The admin dashboard polls every 10s and the "online now" number must feel live,
// so the TTL is only a few seconds: it just absorbs several admins polling at the same moment.
const OVERVIEW_CACHE_TTL_MS = 5_000;
let overviewCache: { at: number; body: Record<string, unknown> } | null = null;
const OVERVIEW_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const authorization = await requireAdmin(request);
  if (authorization.response) return authorization.response;

  const allowCached = new URL(request.url).searchParams.get("cached") === "1";
  if (allowCached && overviewCache && Date.now() - overviewCache.at < OVERVIEW_CACHE_TTL_MS) {
    return NextResponse.json(
      { ...overviewCache.body, admin: authorization.admin },
      { headers: OVERVIEW_HEADERS },
    );
  }

  try {
    await connectDB();
    const now = new Date();
    const activeCutoff = new Date(now.getTime() - PRESENCE_STALE_AFTER_MS);
    const mainAdminEmail = getAdminCredentials().email;
    const databaseUserFilter = mainAdminEmail ? { email: { $ne: mainAdminEmail } } : {};
    const activeSubscriptionFilter = {
      paymentStatus: "COMPLETED",
      accessStatus: "ACTIVE",
      expiresAt: { $gt: now },
    };
    const startOfToday = new Date(`${dayKey(now)}T00:00:00+06:00`);
    const sevenDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(`${dayKey(now).slice(0, 7)}-01T00:00:00+06:00`);
    const previousWeekStart = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
    const realPaymentMatch = {
      paymentStatus: "COMPLETED",
      invoiceId: { $not: /^MOCK-/i },
      paymentMethod: { $not: /MOCK/i },
    };

    const [
      totalUsers,
      activeNow,
      loginsToday,
      activeSubscriberIds,
      activeSubscriptions,
      totalSubscriptions,
      pendingPayments,
      revenueRows,
      registrationRows,
      newToday,
      newThisMonth,
      newPreviousWeek,
      neverLoggedIn,
      bannedUsers,
      districtRows,
      revenueThisMonthRows,
      expiringCounts,
    ] = await Promise.all([
      User.countDocuments(databaseUserFilter),
      User.countDocuments({ ...databaseUserFilter, lastSeenAt: { $gte: activeCutoff } }),
      User.countDocuments({ ...databaseUserFilter, lastLoginAt: { $gte: startOfToday } }),
      Subscription.distinct("userId", activeSubscriptionFilter),
      Subscription.countDocuments(activeSubscriptionFilter),
      Subscription.countDocuments({}),
      Subscription.countDocuments({ paymentStatus: "PENDING" }),
      Subscription.aggregate([
        { $match: realPaymentMatch },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      User.aggregate([
        { $match: { ...databaseUserFilter, createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "Asia/Dhaka",
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      User.countDocuments({ ...databaseUserFilter, createdAt: { $gte: startOfToday } }),
      User.countDocuments({ ...databaseUserFilter, createdAt: { $gte: startOfMonth } }),
      User.countDocuments({
        ...databaseUserFilter,
        createdAt: { $gte: previousWeekStart, $lt: sevenDaysAgo },
      }),
      User.countDocuments({
        ...databaseUserFilter,
        $or: [{ lastLoginAt: null }, { lastLoginAt: { $exists: false } }],
      }),
      User.countDocuments({ ...databaseUserFilter, isBanned: true }),
      User.aggregate([
        { $match: { ...databaseUserFilter, district: { $type: "string", $ne: "" } } },
        { $group: { _id: "$district", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ]),
      Subscription.aggregate([
        { $match: { ...realPaymentMatch, createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      countExpiringCustomers(now),
    ]);

    // Manual withdrawals recorded by the admin are subtracted from revenue.
    let totalWithdrawn = 0;
    try {
      const withdrawnRows = await Withdrawal.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]);
      totalWithdrawn = Number(withdrawnRows[0]?.total || 0);
    } catch (withdrawalError) {
      console.error("Admin overview withdrawals error:", withdrawalError);
    }

    const registrationsByDate = new Map<string, number>(
      registrationRows.map((row: { _id: string; count: number }) => [row._id, row.count]),
    );
    const weeklyRegistrations = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now.getTime() - (6 - index) * 24 * 60 * 60 * 1000);
      const key = dayKey(date);
      return {
        date: key,
        label: new Intl.DateTimeFormat("en", {
          timeZone: "Asia/Dhaka",
          weekday: "short",
        }).format(date),
        count: registrationsByDate.get(key) || 0,
      };
    });

    const weeklyTotal = weeklyRegistrations.reduce((sum, day) => sum + day.count, 0);
    const weeklyGrowthPercent = newPreviousWeek > 0
      ? Math.round(((weeklyTotal - newPreviousWeek) / newPreviousWeek) * 100)
      : null;
    const paidConversionPercent = totalUsers > 0
      ? Math.round((activeSubscriberIds.length / totalUsers) * 1000) / 10
      : 0;
    const topDistrict = districtRows[0]
      ? { name: String(districtRows[0]._id), users: Number(districtRows[0].count || 0) }
      : null;

    let insights = null;
    try {
      insights = await buildInsights({ now, startOfToday, startOfMonth, databaseUserFilter, realPaymentMatch, activeSubscriptionFilter, activeSubscriberIds });
    } catch (insightError) {
      console.error("Admin overview insights error:", insightError);
    }

    const body = {
        success: true,
        stats: {
          totalUsers,
          activeNow,
          loginsToday,
          activeSubscribers: activeSubscriberIds.length,
          activeSubscriptions,
          totalSubscriptions,
          pendingPayments,
          totalRevenue: Number(revenueRows[0]?.total || 0),
          totalWithdrawn,
          netRevenue: Number(revenueRows[0]?.total || 0) - totalWithdrawn,
          newToday,
          newThisMonth,
          weeklyRegistrations: weeklyTotal,
          previousWeekRegistrations: newPreviousWeek,
          weeklyGrowthPercent,
          neverLoggedIn,
          bannedUsers,
          paidConversionPercent,
          revenueThisMonth: Number(revenueThisMonthRows[0]?.total || 0),
          expiringSoon: expiringCounts.week,
          expiringLastDay: expiringCounts.day,
          expiringThreeDays: expiringCounts.three,
          topDistrict,
        },
        weeklyRegistrations,
        insights,
        generatedAt: now.toISOString(),
    };
    overviewCache = { at: Date.now(), body };
    return NextResponse.json(
      { ...body, admin: authorization.admin },
      { headers: OVERVIEW_HEADERS },
    );
  } catch (error) {
    console.error("Admin overview error:", error);
    return NextResponse.json(
      { success: false, message: "Could not load admin overview." },
      { status: 500 },
    );
  }
}
