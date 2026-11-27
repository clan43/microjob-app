/**
 * Shared (server + browser) helpers for admin -> user popup alerts.
 * No server-only imports here: the admin live preview and the real popup use the SAME builder,
 * so what the admin sees in the preview is exactly what the user gets.
 */

export type AlertKind = "info" | "success" | "warning" | "danger" | "offer" | "celebrate" | "maintenance";
export type AlertMode = "template" | "html";
export type AlertAudience = "all" | "subscribed" | "not_subscribed" | "specific";
export type AlertRepeat = "once" | "daily";
export type AlertWidth = "sm" | "md" | "lg";

export type AlertTemplate = {
  kind: AlertKind;
  title: string;
  message: string;
  ctaText: string;
  ctaUrl: string;
  closeText: string;
};

export const ALERT_WIDTH_PX: Record<AlertWidth, number> = { sm: 380, md: 460, lg: 640 };

export const TEMPLATE_MAX = { title: 160, message: 2000, ctaText: 60, ctaUrl: 500, closeText: 40 } as const;
export const HTML_MAX = 90000;

type KindStyle = { label: string; accent: string; accent2: string; soft: string; icon: string };

/** Lucide-style stroke icons, inlined so the popup has no extra requests. */
export const ALERT_KINDS: Record<AlertKind, KindStyle> = {
  info: {
    label: "Information",
    accent: "#2563EB",
    accent2: "#93C5FD",
    soft: "#DBEAFE",
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  },
  success: {
    label: "Success",
    accent: "#16A34A",
    accent2: "#86EFAC",
    soft: "#DCFCE7",
    icon: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  },
  warning: {
    label: "Warning",
    accent: "#D97706",
    accent2: "#FCD34D",
    soft: "#FEF3C7",
    icon: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  },
  danger: {
    label: "Urgent",
    accent: "#DC2626",
    accent2: "#FCA5A5",
    soft: "#FEE2E2",
    icon: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  },
  offer: {
    label: "Offer",
    accent: "#C21B1B",
    accent2: "#F2CB7A",
    soft: "#FDE8D8",
    icon: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
  },
  celebrate: {
    label: "Celebration",
    accent: "#9333EA",
    accent2: "#D8B4FE",
    soft: "#F3E8FF",
    icon: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L8 14.2 3 9.3l6.9-1z"/>',
  },
  maintenance: {
    label: "Maintenance",
    accent: "#EA580C",
    accent2: "#FBBF24",
    soft: "#FFEDD5",
    icon: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  },
};

export const ALERT_KIND_KEYS = Object.keys(ALERT_KINDS) as AlertKind[];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type AlertVars = { name: string; firstName: string; email: string };

/** {{name}} {{firstName}} {{email}} -> the user's values (HTML-escaped so a name can never inject markup). */
export function applyPlaceholders(text: string, vars: AlertVars): string {
  return text
    .replace(/\{\{\s*first_?name\s*\}\}/gi, escapeHtml(vars.firstName || "বন্ধু"))
    .replace(/\{\{\s*name\s*\}\}/gi, escapeHtml(vars.name || vars.firstName || "বন্ধু"))
    .replace(/\{\{\s*email\s*\}\}/gi, escapeHtml(vars.email || ""));
}

/** Only http(s) links and site-relative paths may be used as a button target. */
export function safeAlertUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//") && !/[\s\\]/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function isExternal(url: string) {
  return /^https?:\/\//i.test(url);
}

/** Builds the ready-made popup card. Text fields are escaped here, placeholders are filled by the caller first. */
export function buildAlertHtml(template: AlertTemplate, vars?: AlertVars): string {
  const style = ALERT_KINDS[template.kind] || ALERT_KINDS.info;
  const fill = (text: string) => (vars ? applyPlaceholders(text, vars) : text);
  // placeholders already escape their own values, so escape only the admin's static text around them
  const safe = (text: string) => {
    const tokens: string[] = [];
    const masked = text.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, (m) => {
      tokens.push(m);
      return `\u0000${tokens.length - 1}\u0000`;
    });
    const escaped = escapeHtml(masked);
    return fill(escaped.replace(/\u0000(\d+)\u0000/g, (_m, i) => tokens[Number(i)] || ""));
  };

  const title = safe(template.title.trim());
  const isMaint = template.kind === "maintenance";
  const isOffer = template.kind === "offer";
  const loud = isMaint || isOffer;
  const rawMessage = safe(template.message.trim());
  // Maintenance: the first paragraph becomes a highlighted callout so it cannot be skimmed past.
  const paras = rawMessage.split(/\r?\n\s*\r?\n/);
  const message = loud
    ? paras
        .map((para, i) => `<div class="${i === 0 ? "key" : "rest"}">${para.replace(/\r?\n/g, "<br>")}</div>`)
        .join("")
    : rawMessage.replace(/\r?\n/g, "<br>");
  const ctaUrl = safeAlertUrl(template.ctaUrl);
  const ctaText = escapeHtml(template.ctaText.trim());
  const closeText = escapeHtml(template.closeText.trim() || "বন্ধ করুন");
  const external = ctaUrl && isExternal(ctaUrl);
  const cta =
    ctaUrl && ctaText
      ? `<a class="cta" href="${escapeHtml(ctaUrl)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${ctaText}</a>`
      : "";

  return `<style>
*{box-sizing:border-box}
.card{position:relative;overflow:hidden;border-radius:22px;text-align:center;padding:40px 28px 22px;color:#2B2113;
background:linear-gradient(180deg,#FFFDF7 0%,#FBF3DD 100%);border:1px solid #E8D4A2;
box-shadow:0 32px 80px rgba(43,33,19,.4),0 2px 6px rgba(43,33,19,.12),inset 0 1px 0 #fff;animation:up .45s cubic-bezier(.22,1,.36,1) both}
.bar{position:absolute;inset:0 0 auto 0;height:4px;background:linear-gradient(90deg,${style.accent},${style.accent2} 50%,${style.accent})}
.glow{position:absolute;inset:0 0 auto 0;height:200px;pointer-events:none;background:radial-gradient(ellipse 65% 100% at 50% 0%,${style.soft},transparent 72%)}
.in{position:relative}
.emblem{width:76px;height:76px;margin:0 auto;border-radius:999px;display:grid;place-items:center;color:${style.accent};
background:${style.soft};border:2px solid ${style.accent};box-shadow:0 0 0 7px ${style.soft}99,0 12px 26px rgba(43,33,19,.2)}
.emblem svg{width:32px;height:32px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
h2{margin:22px 0 0;font-size:24px;line-height:1.4;font-weight:800}
p{margin:10px auto 0;max-width:360px;font-size:14.5px;line-height:1.8;color:#6B5A3E}
.actions{margin-top:24px;display:grid;gap:6px}
.cta{display:flex;align-items:center;justify-content:center;height:50px;border-radius:12px;color:#fff;text-decoration:none;
font-size:16px;font-weight:700;background:linear-gradient(180deg,${style.accent} 0%,${style.accent}E6 100%);
box-shadow:0 10px 22px ${style.accent}47,inset 0 1px 0 rgba(255,255,255,.2)}
.later{height:40px;border:0;background:transparent;cursor:pointer;font:inherit;font-size:14px;font-weight:600;color:#8A7753;border-radius:10px}
.later:hover{color:#2B2113;background:rgba(43,33,19,.06)}
@keyframes up{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:none}}
.hz{position:absolute;inset:0 0 auto 0;height:12px;background:repeating-linear-gradient(-45deg,#FBBF24 0 14px,#1F1A12 14px 28px)}
.pill{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;padding:6px 14px;border-radius:999px;background:#1F1A12;color:#FDE68A;font-size:12.5px;font-weight:800;letter-spacing:.04em}
.pill i{width:9px;height:9px;border-radius:999px;background:#FBBF24;animation:pulse 1.2s ease-in-out infinite}
.loud{padding-top:46px;border:2px solid #F5C77E;background:linear-gradient(180deg,#FFFBEF 0%,#FFF1CF 100%)}
.loud .emblem{animation:ring 1.8s ease-out infinite}
.loud h2{font-size:26px;color:#7C2D12}
.loud .msg{margin:14px auto 0;max-width:380px;text-align:center}
.o-card{border-color:#F2B8B8;background:linear-gradient(180deg,#FFFDF7 0%,#FFEFD2 100%)}
.o-card .hz{height:10px;background:linear-gradient(90deg,#B91C1C,#F2CB7A 50%,#B91C1C)}
.o-card .pill{background:#B91C1C;color:#FFF3D6}
.o-card .pill i{background:#FDE68A}
.o-card h2{color:#991B1B}
.o-card .key{background:#FDE8D8;border-color:#C21B1B;color:#7F1D1D}
.o-card .cta{height:54px;font-size:17px;animation:nudge 2.2s ease-in-out infinite}
.key{padding:13px 15px;border-radius:14px;background:#FFE9B8;border:1.5px solid #F59E0B;color:#2B2113;font-size:16px;font-weight:800;line-height:1.7}
.rest{margin-top:12px;font-size:14px;line-height:1.8;color:#6B5A3E}
.m-card .later{height:48px;margin-top:4px;border-radius:12px;background:#1F1A12;color:#FDE68A;font-size:15.5px;font-weight:800}
.m-card .later:hover{background:#2B2113;color:#fff}
@keyframes nudge{0%,100%{transform:scale(1)}50%{transform:scale(1.025)}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
@keyframes ring{0%{box-shadow:0 0 0 0 ${isOffer ? "rgba(194,27,27,.4)" : "rgba(234,88,12,.45)"},0 12px 26px rgba(43,33,19,.2)}100%{box-shadow:0 0 0 16px ${isOffer ? "rgba(194,27,27,0)" : "rgba(234,88,12,0)"},0 12px 26px rgba(43,33,19,.2)}}
@media(max-width:420px){.card{padding:34px 20px 18px}}
@media(prefers-reduced-motion:reduce){.card,.pill i,.loud .emblem,.o-card .cta{animation:none}}
</style>
<div class="card${loud ? " loud" : ""}${isMaint ? " m-card" : ""}${isOffer ? " o-card" : ""}">${loud ? '<div class="hz"></div>' : '<div class="bar"></div>'}<div class="glow"></div><div class="in">
${loud ? `<div class="pill"><i></i>${isOffer ? "সীমিত সময়ের অফার" : "গুরুত্বপূর্ণ নোটিশ"}</div><br>` : ""}<div class="emblem"><svg viewBox="0 0 24 24" aria-hidden="true">${style.icon}</svg></div>
${title ? `<h2>${title}</h2>` : ""}${message ? (loud ? `<div class="msg">${message}</div>` : `<p>${message}</p>`) : ""}
<div class="actions">${cta}<button type="button" class="later" data-alert-close>${closeText}</button></div>
</div></div>`;
}

const BLOCKED_TAGS = "script|iframe|object|embed|form|noscript|frame|frameset|applet|link|base|meta|input|textarea|select|set|animate";

/**
 * First line of defence (server side, string based). The browser view runs a second, DOM based
 * sanitiser (AlertHtmlView) before anything is shown, so this is defence in depth.
 */
export function sanitizeAlertHtml(input: string): string {
  return input
    .replace(new RegExp(`<\\s*(${BLOCKED_TAGS})\\b[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi"), "")
    .replace(new RegExp(`<\\s*\\/?\\s*(${BLOCKED_TAGS})\\b[^>]*>`, "gi"), "")
    .replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\b(href|src|xlink:href|action|formaction)\s*=\s*(["'])\s*(javascript|vbscript|data(?!:image\/))\s*:[^"']*\2/gi, "$1=$2#$2")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "x(")
    .replace(/-moz-binding\s*:/gi, "x:");
}

export const SAMPLE_VARS: AlertVars = { name: "রহিম উদ্দিন", firstName: "রহিম", email: "rahim@example.com" };

/** Final HTML for one user (server) or for the admin preview (browser, with SAMPLE_VARS). */
export function renderAlertHtml(
  alert: { mode: AlertMode; template?: Partial<AlertTemplate> | null; html?: string | null },
  vars: AlertVars,
): string {
  if (alert.mode === "html") return sanitizeAlertHtml(applyPlaceholders(String(alert.html || ""), vars));
  const t = alert.template || {};
  return buildAlertHtml(
    {
      kind: (t.kind as AlertKind) || "info",
      title: String(t.title || ""),
      message: String(t.message || ""),
      ctaText: String(t.ctaText || ""),
      ctaUrl: String(t.ctaUrl || ""),
      closeText: String(t.closeText || ""),
    },
    vars,
  );
}

export type AlertPreset = {
  id: string;
  label: string;
  template: AlertTemplate;
  audience: AlertAudience;
  repeat: AlertRepeat;
};

/** One-click starting points in the admin panel. Everything stays editable. */
export const ALERT_PRESETS: AlertPreset[] = [
  {
    id: "new-tool",
    label: "নতুন টুল চালু",
    audience: "all",
    repeat: "once",
    template: {
      kind: "celebrate",
      title: "নতুন টুল যুক্ত হয়েছে!",
      message: "প্রিয় {{firstName}}, আপনাদের সুবিধার জন্য আমরা নতুন একটি টুল চালু করেছি। এখনই ঘুরে দেখুন।",
      ctaText: "টুলস দেখুন",
      ctaUrl: "/dashboard",
      closeText: "পরে দেখব",
    },
  },
  {
    id: "offer",
    label: "৯৯ টাকার অফার",
    audience: "not_subscribed",
    repeat: "daily",
    template: {
      kind: "offer",
      title: "৯৯ টাকার প্যাকেজ, শুধু সীমিত সময়ের জন্য",
      message:
        "প্রিয় {{firstName}}, মাত্র ৯৯ টাকায় ১ মাসের সব পেইড টুল ব্যবহার করুন! সাধারণ দাম ৩৫০ টাকা।\n\nএটি সীমিত সময়ের অফার। এখন প্যাকেজটি নিলে এই বিশেষ দামেই পাবেন, কিন্তু অফার শেষ হয়ে গেলে আর এই দামে পাওয়া যাবে না।\n\nএআই এডিটর, এআই টেমপ্লেট ও বাল্ক ফটো এডিটসহ সব পেইড টুল একই অ্যাকাউন্টে চালান। দেরি না করে আজই নিয়ে নিন।",
      ctaText: "৯৯ টাকায় প্যাকেজ নিন",
      ctaUrl: "/subscription",
      closeText: "পরে দেখব",
    },
  },
  {
    id: "renew",
    label: "রিনিউ রিমাইন্ডার",
    audience: "subscribed",
    repeat: "once",
    template: {
      kind: "warning",
      title: "সাবস্ক্রিপশন রিনিউ করুন",
      message: "{{firstName}}, আপনার প্রিমিয়াম এক্সেসের মেয়াদ শেষ হওয়ার আগেই রিনিউ করে নিন, কাজ থামবে না।",
      ctaText: "এখনই রিনিউ করুন",
      ctaUrl: "/subscription",
      closeText: "পরে দেখব",
    },
  },
  {
    id: "maintenance",
    label: "মেইনটেনেন্স নোটিশ",
    audience: "all",
    repeat: "once",
    template: {
      kind: "maintenance",
      title: "সার্ভারে কাজ চলছে, ইমেজ জেনারেশন বন্ধ",
      message:
        "প্রিয় {{firstName}}, সার্ভারে কাজ চলার কারণে এখন ইমেজ জেনারেশন বন্ধ আছে। ছবি তৈরি করা যাচ্ছে না।\n\nআপনার ফাইল ও অ্যাকাউন্ট সম্পূর্ণ নিরাপদ আছে। কাজ শেষ হলেই সব আবার স্বাভাবিক হয়ে যাবে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।\n\nঅসুবিধার জন্য আমরা আন্তরিকভাবে দুঃখিত, ধৈর্য ধরার জন্য ধন্যবাদ।",
      ctaText: "",
      ctaUrl: "",
      closeText: "বুঝেছি, পরে চেষ্টা করব",
    },
  },
  {
    id: "thanks",
    label: "ধন্যবাদ বার্তা",
    audience: "subscribed",
    repeat: "once",
    template: {
      kind: "success",
      title: "আমাদের সাথে থাকার জন্য ধন্যবাদ",
      message: "প্রিয় {{firstName}}, আপনার বিশ্বাসই আমাদের পথ চলার শক্তি। কোনো সমস্যা হলে অ্যাডমিনকে চ্যাটে জানান।",
      ctaText: "",
      ctaUrl: "",
      closeText: "ধন্যবাদ",
    },
  },
  {
    id: "urgent",
    label: "জরুরি নোটিশ",
    audience: "all",
    repeat: "once",
    template: {
      kind: "danger",
      title: "জরুরি বিজ্ঞপ্তি",
      message: "গুরুত্বপূর্ণ তথ্য: এখানে আপনার জরুরি বার্তাটি লিখুন।",
      ctaText: "",
      ctaUrl: "",
      closeText: "বন্ধ করুন",
    },
  },
];

export const SAMPLE_CUSTOM_HTML = `<div style="border-radius:20px;overflow:hidden;background:#fff;border:1px solid #E8D4A2;font-family:inherit;text-align:center">
  <div style="background:#2B2113;color:#F2CB7A;padding:18px;font-size:18px;font-weight:800">sebalagbe.com</div>
  <div style="padding:26px 22px">
    <h2 style="margin:0 0 8px;font-size:22px;color:#2B2113">হ্যালো {{firstName}}!</h2>
    <p style="margin:0 0 18px;color:#6B5A3E;line-height:1.7">এখানে আপনার নিজের ডিজাইন করা HTML বসান।</p>
    <a href="/dashboard" style="display:inline-block;background:#C21B1B;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px">ড্যাশবোর্ডে যান</a>
    <div style="margin-top:14px"><button data-alert-close style="border:0;background:none;color:#8A7753;cursor:pointer;font-size:14px">বন্ধ করুন</button></div>
  </div>
</div>`;
