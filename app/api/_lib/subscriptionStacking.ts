import User from "@/models/User";
import Subscription from "@/models/Subscription";

const DAY_MS = 86_400_000;

/**
 * Subscription stacking helpers.
 *
 * Rule: when a customer buys a new plan while paid access is still running, the new plan does
 * NOT start today. It starts the moment the current access ends, so the days left on the old
 * plan are never lost. (1 month with 4 days left + 6 months => access until old-end + 6 months.)
 */

/** The latest moment up to which this user already has paid access (null when nothing is running). */
export async function getStackBaseDate(
  userId: unknown,
  excludeSubscriptionId?: unknown,
  now: Date = new Date(),
): Promise<Date | null> {
  const filter: Record<string, unknown> = {
    userId,
    paymentStatus: "COMPLETED",
    accessStatus: "ACTIVE",
    expiresAt: { $gt: now },
  };
  if (excludeSubscriptionId) filter._id = { $ne: excludeSubscriptionId };
  const latest = await Subscription.findOne(filter).sort({ expiresAt: -1 }).select("expiresAt").lean<{ expiresAt?: Date }>();
  return latest?.expiresAt ? new Date(latest.expiresAt) : null;
}

/** Start/end dates for a plan of `days` days that is bought now, stacked after any running access. */
export async function computeStackedPeriod(
  userId: unknown,
  days: number,
  excludeSubscriptionId?: unknown,
  now: Date = new Date(),
): Promise<{ startedAt: Date; expiresAt: Date; carriedOverDays: number }> {
  const base = await getStackBaseDate(userId, excludeSubscriptionId, now);
  const startedAt = base && base.getTime() > now.getTime() ? base : now;
  const expiresAt = new Date(startedAt);
  expiresAt.setDate(expiresAt.getDate() + days);
  const carriedOverDays = startedAt === now ? 0 : Math.ceil((startedAt.getTime() - now.getTime()) / DAY_MS);
  return { startedAt, expiresAt, carriedOverDays };
}

/**
 * For each user: the date their total paid access really ends (latest expiry across all running
 * paid plans, and admin-granted manual access). Users with no running access are left out.
 */
export async function getUserAccessEnds(userIds: unknown[], now: Date = new Date()): Promise<Map<string, Date>> {
  const ends = new Map<string, Date>();
  if (!userIds.length) return ends;

  const rows = await Subscription.aggregate([
    {
      $match: {
        userId: { $in: userIds },
        paymentStatus: "COMPLETED",
        accessStatus: "ACTIVE",
        expiresAt: { $gt: now },
      },
    },
    { $group: { _id: "$userId", end: { $max: "$expiresAt" } } },
  ]);
  for (const row of rows) ends.set(String(row._id), new Date(row.end));

  const manualUsers: any[] = await User.find({
    _id: { $in: userIds },
    manualAccessEnabled: true,
    manualAccessExpiresAt: { $gt: now },
  })
    .select("manualAccessExpiresAt")
    .lean();
  for (const user of manualUsers) {
    const key = String(user._id);
    const manualEnd = new Date(user.manualAccessExpiresAt);
    const current = ends.get(key);
    if (!current || manualEnd.getTime() > current.getTime()) ends.set(key, manualEnd);
  }
  return ends;
}
