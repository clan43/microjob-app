import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import User from "@/models/User";
import Subscription from "@/models/Subscription";
import UserAlert from "@/models/UserAlert";
import UserAlertReceipt from "@/models/UserAlertReceipt";
import { requireAdmin } from "@/app/api/admin/_lib/adminAuth";
import {
  ALERT_KIND_KEYS,
  HTML_MAX,
  TEMPLATE_MAX,
  safeAlertUrl,
  sanitizeAlertHtml,
  type AlertAudience,
  type AlertKind,
  type AlertMode,
  type AlertRepeat,
  type AlertWidth,
} from "@/app/_lib/userAlertRender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate" };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_TARGETS = 300;

const fail = (message: string, status = 400) =>
  NextResponse.json({ success: false, message }, { status, headers: NO_STORE });

function parseDate(value: unknown): Date | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

type Parsed = {
  name: string;
  mode: AlertMode;
  template: { kind: AlertKind; title: string; message: string; ctaText: string; ctaUrl: string; closeText: string };
  html: string;
  width: AlertWidth;
  audience: AlertAudience;
  targetEmails: string[];
  repeat: AlertRepeat;
  startsAt: Date | null;
  expiresAt: Date | null;
  active: boolean;
};

function parsePayload(body: any): Parsed | { error: string } {
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name) return { error: "Give this alert a name (only you will see it)." };

  const mode: AlertMode = body.mode === "html" ? "html" : "template";
  const t = body.template && typeof body.template === "object" ? body.template : {};
  const kind: AlertKind = ALERT_KIND_KEYS.includes(t.kind) ? t.kind : "info";
  const template = {
    kind,
    title: String(t.title || "").trim().slice(0, TEMPLATE_MAX.title),
    message: String(t.message || "").trim().slice(0, TEMPLATE_MAX.message),
    ctaText: String(t.ctaText || "").trim().slice(0, TEMPLATE_MAX.ctaText),
    ctaUrl: String(t.ctaUrl || "").trim().slice(0, TEMPLATE_MAX.ctaUrl),
    closeText: String(t.closeText || "").trim().slice(0, TEMPLATE_MAX.closeText),
  };
  const html = String(body.html || "").trim();

  if (mode === "template") {
    if (!template.title && !template.message) return { error: "Write a title or a message for the popup." };
    if (template.ctaUrl && !safeAlertUrl(template.ctaUrl)) {
      return { error: "The button link must start with https://, http:// or / (a page of this site)." };
    }
    if ((template.ctaText && !template.ctaUrl) || (!template.ctaText && template.ctaUrl)) {
      return { error: "The button needs both a text and a link, or leave both empty." };
    }
    template.ctaUrl = safeAlertUrl(template.ctaUrl);
  } else {
    if (!html) return { error: "Paste the HTML design." };
    if (html.length > HTML_MAX) return { error: "The HTML is too large (max 90,000 characters)." };
  }

  const audience: AlertAudience = ["all", "subscribed", "not_subscribed", "specific"].includes(body.audience)
    ? body.audience
    : "all";
  const rawEmails = Array.isArray(body.targetEmails)
    ? body.targetEmails.join("\n")
    : String(body.targetEmails || "");
  const targetEmails = Array.from(
    new Set(rawEmails.split(/[\s,;]+/).map((e: string) => e.trim().toLowerCase()).filter((e: string) => EMAIL_RE.test(e))),
  ).slice(0, MAX_TARGETS) as string[];
  if (audience === "specific" && targetEmails.length === 0) {
    return { error: "Enter at least one valid user email for 'Specific users'." };
  }

  const startsAt = parseDate(body.startsAt);
  const expiresAt = parseDate(body.expiresAt);
  if (startsAt === "invalid" || expiresAt === "invalid") return { error: "A date is not valid." };
  if (startsAt && expiresAt && expiresAt <= startsAt) return { error: "The end time must be after the start time." };
  if (expiresAt && expiresAt.getTime() <= Date.now() && body.active !== false) {
    return { error: "The end time is already in the past." };
  }

  return {
    name,
    mode,
    template,
    html: mode === "html" ? sanitizeAlertHtml(html) : "",
    width: body.width === "sm" || body.width === "lg" ? body.width : "md",
    audience,
    targetEmails: audience === "specific" ? targetEmails : [],
    repeat: body.repeat === "daily" ? "daily" : "once",
    startsAt,
    expiresAt,
    active: body.active !== false,
  };
}

async function audienceCounts() {
  const base = { isBanned: { $ne: true }, role: { $ne: "admin" } };
  const activeIds = await Subscription.distinct("userId", {
    paymentStatus: "COMPLETED",
    accessStatus: "ACTIVE",
    expiresAt: { $gt: new Date() },
  });
  const [all, subscribed] = await Promise.all([
    User.countDocuments(base),
    User.countDocuments({ ...base, _id: { $in: activeIds } }),
  ]);
  return { all, subscribed, not_subscribed: Math.max(0, all - subscribed) };
}

function serialize(doc: any, stats?: { shown: number; dismissed: number; clicked: number }, counts?: Record<string, number>) {
  const specificCount = Array.isArray(doc.targetUserIds) ? doc.targetUserIds.length : 0;
  return {
    id: String(doc._id),
    name: doc.name,
    mode: doc.mode,
    template: doc.template || {},
    html: doc.html || "",
    width: doc.width || "md",
    audience: doc.audience,
    targetEmails: doc.targetEmails || [],
    repeat: doc.repeat,
    startsAt: doc.startsAt || null,
    expiresAt: doc.expiresAt || null,
    active: doc.active !== false,
    createdAt: doc.createdAt,
    stats: stats || { shown: 0, dismissed: 0, clicked: 0 },
    targetCount: doc.audience === "specific" ? specificCount : counts?.[doc.audience] ?? 0,
  };
}

export async function GET(request: Request) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  try {
    await connectDB();
    const docs: any[] = await UserAlert.find({}).sort({ createdAt: -1 }).limit(100).lean();
    const ids = docs.map((d) => d._id);
    const [counts, statRows] = await Promise.all([
      audienceCounts(),
      ids.length
        ? UserAlertReceipt.aggregate([
            { $match: { alertId: { $in: ids } } },
            {
              $group: {
                _id: "$alertId",
                shown: { $sum: { $cond: [{ $gt: ["$shownCount", 0] }, 1, 0] } },
                dismissed: { $sum: { $cond: [{ $ifNull: ["$dismissedAt", false] }, 1, 0] } },
                clicked: { $sum: { $cond: [{ $ifNull: ["$clickedAt", false] }, 1, 0] } },
              },
            },
          ])
        : Promise.resolve([]),
    ]);
    const statsById = new Map<string, { shown: number; dismissed: number; clicked: number }>();
    for (const row of statRows as any[]) {
      statsById.set(String(row._id), { shown: row.shown, dismissed: row.dismissed, clicked: row.clicked });
    }
    return NextResponse.json(
      { success: true, counts, alerts: docs.map((d) => serialize(d, statsById.get(String(d._id)), counts)) },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("User alerts list failed:", error instanceof Error ? error.message : "Unknown error");
    return fail("Could not load alerts.", 500);
  }
}

/** Resolves typed emails to user ids. Returns the ids and the emails that matched nobody. */
async function resolveTargets(emails: string[]) {
  if (emails.length === 0) return { ids: [] as mongoose.Types.ObjectId[], missing: [] as string[] };
  const users: any[] = await User.find({ email: { $in: emails }, isBanned: { $ne: true } }).select("_id email").lean();
  const found = new Set(users.map((u) => String(u.email || "").toLowerCase()));
  return { ids: users.map((u) => u._id as mongoose.Types.ObjectId), missing: emails.filter((e) => !found.has(e)) };
}

/**
 * action "create" (default) | "update" | "toggle" | "resend" | "delete"
 *  - resend: forgets who already closed the popup, so everyone in the audience sees it again
 */
export async function POST(request: Request) {
  const { admin, response } = await requireAdmin(request);
  if (response) return response;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return fail("Invalid request.");
  const action = String(body.action || "create");

  try {
    await connectDB();

    if (action === "create" || action === "update") {
      const parsed = parsePayload(body);
      if ("error" in parsed) return fail(parsed.error);
      const { ids, missing } = await resolveTargets(parsed.targetEmails);
      if (parsed.audience === "specific" && ids.length === 0) {
        return fail("None of those emails belong to a registered user.");
      }
      const data = { ...parsed, targetUserIds: parsed.audience === "specific" ? ids : [] };

      let doc: any;
      if (action === "create") {
        doc = await UserAlert.create({ ...data, createdBy: admin?.email || "" });
      } else {
        if (!mongoose.isValidObjectId(body.id)) return fail("Alert not found.", 404);
        doc = await UserAlert.findByIdAndUpdate(body.id, { $set: data }, { new: true }).lean();
        if (!doc) return fail("Alert not found.", 404);
      }
      return NextResponse.json(
        { success: true, alert: serialize(doc), missingEmails: missing },
        { headers: NO_STORE },
      );
    }

    if (!mongoose.isValidObjectId(body.id)) return fail("Alert not found.", 404);

    if (action === "toggle") {
      const doc = await UserAlert.findByIdAndUpdate(body.id, { $set: { active: body.active === true } }, { new: true }).lean();
      if (!doc) return fail("Alert not found.", 404);
      return NextResponse.json({ success: true }, { headers: NO_STORE });
    }

    if (action === "resend") {
      const exists = await UserAlert.exists({ _id: body.id });
      if (!exists) return fail("Alert not found.", 404);
      await UserAlertReceipt.deleteMany({ alertId: body.id });
      await UserAlert.updateOne({ _id: body.id }, { $set: { active: true } });
      return NextResponse.json({ success: true }, { headers: NO_STORE });
    }

    if (action === "delete") {
      await Promise.all([UserAlert.deleteOne({ _id: body.id }), UserAlertReceipt.deleteMany({ alertId: body.id })]);
      return NextResponse.json({ success: true }, { headers: NO_STORE });
    }

    return fail("Unknown action.");
  } catch (error) {
    console.error("User alerts action failed:", error instanceof Error ? error.message : "Unknown error");
    return fail("Could not save the alert.", 500);
  }
}
