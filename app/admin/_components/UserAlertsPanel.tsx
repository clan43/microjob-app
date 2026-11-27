"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Eye,
  Gift,
  Heart,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { getClientAuthHeaders } from "@/lib/clientAuth";
import AlertHtmlView from "@/app/_components/AlertHtmlView";
import {
  ALERT_KINDS,
  ALERT_KIND_KEYS,
  ALERT_PRESETS,
  ALERT_WIDTH_PX,
  HTML_MAX,
  SAMPLE_CUSTOM_HTML,
  SAMPLE_VARS,
  TEMPLATE_MAX,
  renderAlertHtml,
  type AlertAudience,
  type AlertKind,
  type AlertMode,
  type AlertRepeat,
  type AlertTemplate,
  type AlertWidth,
} from "@/app/_lib/userAlertRender";

const CARD = "rounded-2xl border border-[#E3D6B8] bg-[#FBF6E8] p-5 shadow-sm sm:p-6";
const INPUT =
  "mt-1.5 w-full rounded-lg border border-[#E3D6B8] bg-white px-3 py-2.5 text-sm text-[#3B2F1E] outline-none transition placeholder:text-[#A8977A] focus:border-[#DC2626] focus:ring-4 focus:ring-red-500/10";
const LABEL = "block text-[12px] font-semibold uppercase tracking-wide text-[#6B5A40]";
const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#E3D6B8] bg-white px-3 py-2 text-xs font-semibold text-[#3B2F1E] transition hover:bg-[#F5EBD0] disabled:cursor-not-allowed disabled:opacity-50";

type Counts = { all: number; subscribed: number; not_subscribed: number };
type AlertRow = {
  id: string;
  name: string;
  mode: AlertMode;
  template: Partial<AlertTemplate>;
  html: string;
  width: AlertWidth;
  audience: AlertAudience;
  targetEmails: string[];
  repeat: AlertRepeat;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  stats: { shown: number; dismissed: number; clicked: number };
  targetCount: number;
};

type Form = {
  name: string;
  mode: AlertMode;
  template: AlertTemplate;
  html: string;
  width: AlertWidth;
  audience: AlertAudience;
  targetEmails: string;
  repeat: AlertRepeat;
  startsAt: string;
  expiresAt: string;
};

const EMPTY_TEMPLATE: AlertTemplate = { kind: "info", title: "", message: "", ctaText: "", ctaUrl: "", closeText: "" };
const EMPTY_FORM: Form = {
  name: "",
  mode: "template",
  template: EMPTY_TEMPLATE,
  html: "",
  width: "md",
  audience: "all",
  targetEmails: "",
  repeat: "once",
  startsAt: "",
  expiresAt: "",
};

const toLocalInput = (value: string | null) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};
const fmt = (value: string | null) =>
  value ? new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

const KIND_BN: Record<AlertKind, string> = {
  info: "তথ্য",
  success: "সফল / ধন্যবাদ",
  warning: "সতর্কতা",
  danger: "জরুরি",
  offer: "অফার",
  celebrate: "উদযাপন",
  maintenance: "মেইনটেনেন্স",
};

const PRESET_META: Record<string, { icon: typeof Bell; hint: string }> = {
  maintenance: { icon: Wrench, hint: "সার্ভারে কাজ চললে সবাইকে সাথে সাথে জানান। ইমেজ জেনারেশন বন্ধ থাকার কথাও লেখা আছে। শুধু চেপে “পাঠান” দিন।" },
  "new-tool": { icon: Sparkles, hint: "নতুন টুল চালু হলে সবাইকে জানান" },
  offer: { icon: Gift, hint: "৯৯ টাকার সীমিত সময়ের অফার। যারা এখনো সাবস্ক্রাইব করেনি তারা সাইটে ঢুকলেই প্রতিদিন একবার দেখবে (অটো), নতুন ইউজাররাও।" },
  renew: { icon: Clock, hint: "সাবস্ক্রিপশন শেষ হওয়ার আগে মনে করিয়ে দিন" },
  thanks: { icon: Heart, hint: "সাবস্ক্রাইবারদের ধন্যবাদ জানান" },
  urgent: { icon: AlertTriangle, hint: "যেকোনো জরুরি কথা সবাইকে জানান" },
};

function StepTitle({ n, title, hint }: { n: string; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#3B2F1E] text-sm font-bold text-[#F2CB7A]">{n}</span>
      <div>
        <h3 className="text-base font-bold text-[#3B2F1E]">{title}</h3>
        {hint && <p className="text-xs text-[#6B5A40]">{hint}</p>}
      </div>
    </div>
  );
}

function statusOf(row: AlertRow): { label: string; tone: string } {
  const now = Date.now();
  if (!row.active) return { label: "বন্ধ আছে", tone: "bg-stone-200 text-stone-700" };
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return { label: "মেয়াদ শেষ", tone: "bg-stone-200 text-stone-700" };
  if (row.startsAt && new Date(row.startsAt).getTime() > now) return { label: "পরে চালু হবে", tone: "bg-blue-100 text-blue-800" };
  return { label: "চালু আছে", tone: "bg-green-100 text-green-800" };
}

export type AlertPrefill = { email: string; name?: string; nonce: number };

export default function UserAlertsPanel({
  prefill,
  onPrefillUsed,
}: {
  prefill?: AlertPrefill | null;
  onPrefillUsed?: () => void;
} = {}) {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fullPreview, setFullPreview] = useState(false);
  const [activePreset, setActivePreset] = useState<string>("");
  const [ctaOpen, setShowCtaOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const formRef = useRef<HTMLDivElement | null>(null);

  const call = useCallback(async (body?: Record<string, unknown>) => {
    const response = await fetch("/api/admin/user-alerts", {
      method: body ? "POST" : "GET",
      credentials: "include",
      cache: "no-store",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...getClientAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.message || "Something went wrong.");
    return data;
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await call();
      setAlerts(data.alerts || []);
      setCounts(data.counts || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load alerts.");
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const previewHtml = useMemo(
    () => renderAlertHtml({ mode: form.mode, template: form.template, html: form.html }, SAMPLE_VARS),
    [form.mode, form.template, form.html],
  );
  const previewEmpty = form.mode === "html" ? !form.html.trim() : !form.template.title.trim() && !form.template.message.trim();

  const setTpl = (patch: Partial<AlertTemplate>) => setForm((f) => ({ ...f, template: { ...f.template, ...patch } }));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const reset = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setActivePreset("");
    setShowCtaOpen(false);
  };

  const payload = (extra: Record<string, unknown> = {}) => ({
    name: form.name.trim() || form.template.title.trim() || "Alert",
    mode: form.mode,
    template: form.template,
    html: form.html,
    width: form.width,
    audience: form.audience,
    targetEmails: form.targetEmails,
    repeat: form.repeat,
    startsAt: fromLocalInput(form.startsAt),
    expiresAt: fromLocalInput(form.expiresAt),
    ...extra,
  });

  const save = async () => {
    setError("");
    setNotice("");
    setBusy("save");
    try {
      const data = await call(editingId ? payload({ action: "update", id: editingId }) : payload({ action: "create" }));
      const missing: string[] = data.missingEmails || [];
      setNotice(
        (editingId ? "অ্যালার্ট আপডেট হয়েছে।" : "অ্যালার্ট চালু হয়ে গেছে। ইউজাররা সাইটে ঢুকলে বা পেজ বদলালে এটা দেখতে পাবে।") +
          (missing.length ? ` এই ইমেইল পাওয়া যায়নি (বাদ গেছে): ${missing.join(", ")}` : ""),
      );
      reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy("");
    }
  };

  const act = async (id: string, action: "toggle" | "resend" | "delete", extra: Record<string, unknown> = {}, ok = "") => {
    setError("");
    setNotice("");
    setBusy(`${action}:${id}`);
    try {
      await call({ action, id, ...extra });
      if (ok) setNotice(ok);
      if (editingId === id && action === "delete") reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy("");
    }
  };

  const edit = (row: AlertRow, asCopy = false) => {
    setEditingId(asCopy ? null : row.id);
    setForm({
      name: asCopy ? `${row.name} (copy)` : row.name,
      mode: row.mode,
      template: { ...EMPTY_TEMPLATE, ...row.template } as AlertTemplate,
      html: row.html || "",
      width: row.width,
      audience: row.audience,
      targetEmails: (row.targetEmails || []).join("\n"),
      repeat: row.repeat,
      startsAt: toLocalInput(row.startsAt),
      expiresAt: toLocalInput(row.expiresAt),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToForm = () => {
    window.setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  const pickPreset = (id: string) => {
    const preset = ALERT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setActivePreset(id);
    setEditingId(null);
    setForm((f) => {
      // when the admin came here to message one particular user, keep that user selected
      const keepUser = f.audience === "specific" && f.targetEmails.trim() !== "";
      return {
        ...f,
        name: keepUser ? f.name : preset.label,
        mode: "template",
        template: { ...preset.template },
        audience: keepUser ? "specific" : preset.audience,
        repeat: keepUser ? "once" : preset.repeat,
      };
    });
    setShowCtaOpen(Boolean(preset.template.ctaText || preset.template.ctaUrl));
    scrollToForm();
  };

  const startBlank = () => {
    setActivePreset("blank");
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowCtaOpen(false);
    scrollToForm();
  };

  /**
   * Clicking a type normally just changes the colour/icon. For "Maintenance" and "Offer" we also fill
   * in the ready-made message, but only while title and message are still empty so we never
   * overwrite something the admin has already typed.
   */
  const pickKind = (k: AlertKind) => {
    const presetId = k === "maintenance" ? "maintenance" : k === "offer" ? "offer" : "";
    if (presetId && !form.template.title.trim() && !form.template.message.trim()) {
      pickPreset(presetId);
      return;
    }
    setTpl({ kind: k });
  };

  // Coming from Users -> "Send popup": message this one user (ready-made offer, editable)
  useEffect(() => {
    if (!prefill?.email) return;
    const preset = ALERT_PRESETS.find((x) => x.id === "offer");
    setEditingId(null);
    setActivePreset("offer");
    setForm({
      ...EMPTY_FORM,
      name: `${preset?.label || "Popup"} - ${prefill.name || prefill.email}`,
      template: preset ? { ...preset.template } : EMPTY_TEMPLATE,
      audience: "specific",
      targetEmails: prefill.email,
      repeat: "once",
    });
    setShowCtaOpen(true);
    setNotice(`${prefill.name || prefill.email} এর জন্য বার্তা তৈরি। চাইলে অন্য বার্তা বাছতে বা লেখা বদলাতে পারেন, তারপর “ইউজারদের পাঠান” চাপুন।`);
    onPrefillUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const audienceOptions: Array<{ key: AlertAudience; label: string }> = [
    { key: "all", label: `সব ইউজার${counts ? ` (${counts.all})` : ""}` },
    { key: "subscribed", label: `সক্রিয় সাবস্ক্রাইবার${counts ? ` (${counts.subscribed})` : ""}` },
    { key: "not_subscribed", label: `যারা সাবস্ক্রাইব করেনি${counts ? ` (${counts.not_subscribed})` : ""}` },
    { key: "specific", label: "নির্দিষ্ট ইউজার (ইমেইল দিয়ে)" },
  ];


  const selectedAudience = audienceOptions.find((o) => o.key === form.audience)?.label || "";
  const repeatShort = form.repeat === "daily" ? "প্রতিদিন একবার" : "একবার";
  const canSend = !previewEmpty && busy !== "save";

  return (
    <div className="space-y-6">
      {/* ---------------- header + how it works ---------------- */}
      <section className={CARD}>
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#3B2F1E] text-[#F2CB7A]">
            <Bell size={20} />
          </span>
          <div>
            <h2 className="text-xl font-bold text-[#3B2F1E]">ইউজার অ্যালার্ট</h2>
            <p className="mt-0.5 text-sm text-[#6B5A40]">
              এখান থেকে আপনার ইউজারদের স্ক্রিনে একটি পপআপ বার্তা পাঠাতে পারবেন। যেমন: সার্ভারে কাজ চলছে, নতুন অফার, জরুরি নোটিশ।
            </p>
          </div>
        </div>
        <ol className="mt-4 grid gap-2 sm:grid-cols-3">
          {[
            ["১", "বার্তা বাছুন", "নিচ থেকে একটি রেডিমেড বার্তা চাপুন"],
            ["২", "দেখে নিন", "ডান পাশে ইউজার যেমন দেখবে তেমন দেখা যাবে"],
            ["৩", "পাঠান", "লাল “ইউজারদের পাঠান” বাটন চাপুন"],
          ].map(([n, t, d]) => (
            <li key={n} className="flex items-center gap-3 rounded-xl border border-[#E3D6B8] bg-white px-3 py-2.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#3B2F1E] text-sm font-bold text-[#F2CB7A]">{n}</span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-[#3B2F1E]">{t}</span>
                <span className="block text-xs text-[#6B5A40]">{d}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {(error || notice) && (
        <div
          className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
            error ? "border-red-200 bg-red-50 text-red-800" : "border-green-200 bg-green-50 text-green-800"
          }`}
        >
          {error ? <AlertCircle size={16} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
          <span>{error || notice}</span>
        </div>
      )}

      {/* ---------------- step 1: pick a message ---------------- */}
      <section className={CARD}>
        <StepTitle n="১" title="কোন বার্তা পাঠাবেন?" hint="একটি বাছুন। লেখা নিজে থেকে বসে যাবে, পরে চাইলে বদলাতে পারবেন।" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...ALERT_PRESETS]
            .sort((a, b) => (a.id === "maintenance" ? -1 : b.id === "maintenance" ? 1 : 0))
            .map((p) => {
              const meta = PRESET_META[p.id] || { icon: Bell, hint: "" };
              const Icon = meta.icon;
              const featured = p.id === "maintenance";
              const on = activePreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickPreset(p.id)}
                  className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition ${
                    featured ? "sm:col-span-2 lg:col-span-3" : ""
                  } ${
                    on
                      ? "border-[#3B2F1E] bg-white ring-2 ring-[#3B2F1E]/20"
                      : featured
                        ? "border-[#F5C77E] bg-[#FFF3D6] hover:bg-[#FFEBC2]"
                        : "border-[#E3D6B8] bg-white hover:bg-[#F5EBD0]"
                  }`}
                >
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white"
                    style={{ background: ALERT_KINDS[p.template.kind].accent }}
                  >
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#3B2F1E]">
                      {p.label}
                      {featured && (
                        <span className="rounded-full bg-[#EA580C] px-2 py-0.5 text-[10.5px] font-bold text-white">সার্ভারের কাজে এটা চাপুন</span>
                      )}
                      {on && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10.5px] font-bold text-green-800">বাছাই করা</span>}
                    </span>
                    <span className="mt-0.5 block text-xs text-[#6B5A40]">{meta.hint}</span>
                  </span>
                </button>
              );
            })}
          <button
            type="button"
            onClick={startBlank}
            className={`flex items-start gap-3 rounded-xl border border-dashed p-3.5 text-left transition hover:bg-[#F5EBD0] ${
              activePreset === "blank" ? "border-[#3B2F1E] bg-white ring-2 ring-[#3B2F1E]/20" : "border-[#CDBB93] bg-transparent"
            }`}
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#E3D6B8] text-[#3B2F1E]">
              <Pencil size={18} />
            </span>
            <span>
              <span className="block text-sm font-bold text-[#3B2F1E]">নিজে লিখব</span>
              <span className="mt-0.5 block text-xs text-[#6B5A40]">ফাঁকা থেকে নিজের মতো করে লিখুন</span>
            </span>
          </button>
        </div>
      </section>

      <div ref={formRef} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        {/* ---------------- composer ---------------- */}
        <section className={`${CARD} space-y-6`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StepTitle n="২" title={editingId ? "বার্তা এডিট করুন" : "লেখা দেখে নিন, দরকারে বদলান"} />
            {editingId && (
              <button type="button" className={BTN} onClick={reset}>
                <X size={14} /> এডিট বাতিল
              </button>
            )}
          </div>

          {form.mode === "template" ? (
            <div className="space-y-4">
              <div>
                <span className={LABEL}>ধরন (পপআপের রং ও আইকন)</span>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {ALERT_KIND_KEYS.map((k: AlertKind) => {
                    const s = ALERT_KINDS[k];
                    const on = form.template.kind === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => pickKind(k)}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-semibold transition ${
                          on ? "border-[#3B2F1E] bg-white ring-2 ring-[#3B2F1E]/15" : "border-[#E3D6B8] bg-white hover:bg-[#F5EBD0]"
                        }`}
                      >
                        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.accent }} />
                        {KIND_BN[k]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="block">
                <span className={LABEL}>শিরোনাম</span>
                <input
                  className={INPUT}
                  value={form.template.title}
                  maxLength={TEMPLATE_MAX.title}
                  placeholder="যেমন: সার্ভারে কাজ চলছে"
                  onChange={(e) => setTpl({ title: e.target.value })}
                />
              </label>
              <label className="block">
                <span className={LABEL}>বার্তা</span>
                <textarea
                  className={`${INPUT} min-h-[150px] resize-y`}
                  value={form.template.message}
                  maxLength={TEMPLATE_MAX.message}
                  placeholder="এখানে ইউজারকে কী জানাতে চান লিখুন"
                  onChange={(e) => setTpl({ message: e.target.value })}
                />
                <span className="mt-1 block text-[11.5px] text-[#8A7753]">
                  টিপস: <code>{"{{firstName}}"}</code> লিখলে প্রতিটি ইউজারের কাছে তার নিজের নাম বসে যাবে। নতুন প্যারাগ্রাফের জন্য একটি ফাঁকা লাইন দিন।
                </span>
              </label>
              <label className="block">
                <span className={LABEL}>বন্ধ করার বাটনের লেখা</span>
                <input
                  className={INPUT}
                  value={form.template.closeText}
                  maxLength={TEMPLATE_MAX.closeText}
                  onChange={(e) => setTpl({ closeText: e.target.value })}
                  placeholder="বন্ধ করুন"
                />
              </label>

              <div className="rounded-xl border border-[#E3D6B8] bg-white">
                <button
                  type="button"
                  onClick={() => setShowCtaOpen((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
                >
                  <span>
                    <span className="block text-sm font-bold text-[#3B2F1E]">পপআপে একটি লিংক বাটন যোগ করবেন?</span>
                    <span className="block text-xs text-[#6B5A40]">ঐচ্ছিক। যেমন “সাবস্ক্রিপশন দেখুন” চাপলে ইউজার ওই পেজে যাবে।</span>
                  </span>
                  <ChevronDown size={16} className={`shrink-0 text-[#6B5A40] transition ${ctaOpen ? "rotate-180" : ""}`} />
                </button>
                {ctaOpen && (
                  <div className="grid gap-4 border-t border-[#E3D6B8] p-3.5 sm:grid-cols-2">
                    <label className="block">
                      <span className={LABEL}>বাটনের লেখা</span>
                      <input className={INPUT} value={form.template.ctaText} maxLength={TEMPLATE_MAX.ctaText} onChange={(e) => setTpl({ ctaText: e.target.value })} placeholder="যেমন: অফারটি নিন" />
                    </label>
                    <label className="block">
                      <span className={LABEL}>বাটনের লিংক</span>
                      <input className={INPUT} value={form.template.ctaUrl} maxLength={TEMPLATE_MAX.ctaUrl} onChange={(e) => setTpl({ ctaUrl: e.target.value })} placeholder="/subscription অথবা https://..." />
                    </label>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <label className="block">
              <span className={LABEL}>HTML কোড</span>
              <textarea
                className={`${INPUT} min-h-[260px] resize-y font-mono text-[12.5px]`}
                value={form.html}
                maxLength={HTML_MAX}
                spellCheck={false}
                onChange={(e) => set({ html: e.target.value })}
              />
              <span className="mt-1 block text-[11.5px] leading-relaxed text-[#8A7753]">
                ইনলাইন স্টাইল বা {"<style>"} দিয়ে পুরো ডিজাইন লিখুন। বন্ধ করার বাটনে <code>data-alert-close</code> যোগ করুন। প্লেসহোল্ডার:{" "}
                {"{{firstName}}"}, {"{{name}}"}, {"{{email}}"}। নিরাপত্তার জন্য script, form, iframe বাদ যাবে।
              </span>
            </label>
          )}

          {/* ---------------- step 3: who ---------------- */}
          <div className="space-y-4 border-t border-[#E3D6B8] pt-5">
            <StepTitle n="৩" title="কাকে পাঠাবেন?" />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>কাদের কাছে যাবে</span>
                <select className={INPUT} value={form.audience} onChange={(e) => set({ audience: e.target.value as AlertAudience })}>
                  {audienceOptions.map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>কতবার দেখাবে</span>
                <select className={INPUT} value={form.repeat} onChange={(e) => set({ repeat: e.target.value as AlertRepeat })}>
                  <option value="once">একবার, ইউজার বন্ধ করলে আর দেখাবে না</option>
                  <option value="daily">প্রতিদিন একবার, যতদিন চালু থাকে</option>
                </select>
              </label>
            </div>
            {(form.audience === "not_subscribed" || form.audience === "subscribed" || form.audience === "all") && (
              <p className="rounded-lg border border-[#E3D6B8] bg-white px-3 py-2.5 text-xs leading-relaxed text-[#6B5A40]">
                <b className="text-[#3B2F1E]">অটো মোড:</b>{" "}
                {form.audience === "not_subscribed"
                  ? "এখন থেকে যে ইউজারই সাবস্ক্রিপশন ছাড়া সাইটে ঢুকবে (নতুন ইউজাররাও), সে নিজে থেকেই এই পপআপ দেখবে। কেউ সাবস্ক্রিপশন কিনলে তার কাছে আর যাবে না।"
                  : form.audience === "subscribed"
                    ? "এখন থেকে সক্রিয় সাবস্ক্রিপশন আছে এমন যে ইউজারই সাইটে ঢুকবে, সে নিজে থেকেই এটা দেখবে।"
                    : "এখন থেকে যে ইউজারই সাইটে ঢুকবে, সে নিজে থেকেই এটা দেখবে।"}{" "}
                {form.repeat === "daily" ? "ইউজার বন্ধ করলেও পরদিন আবার দেখাবে।" : "ইউজার একবার বন্ধ করলে আর দেখাবে না।"} আপনি “বন্ধ করুন” না চাপা পর্যন্ত চলবে।
              </p>
            )}
            {form.audience === "specific" && (
              <label className="block">
                <span className={LABEL}>ইউজারদের ইমেইল (প্রতি লাইনে একটি, বা কমা দিয়ে)</span>
                <textarea className={`${INPUT} min-h-[90px] resize-y`} value={form.targetEmails} onChange={(e) => set({ targetEmails: e.target.value })} placeholder={"user1@gmail.com\nuser2@gmail.com"} />
              </label>
            )}
          </div>

          {/* ---------------- advanced ---------------- */}
          <div className="rounded-xl border border-[#E3D6B8] bg-white">
            <button
              type="button"
              onClick={() => setAdvOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
            >
              <span>
                <span className="block text-sm font-bold text-[#3B2F1E]">অতিরিক্ত অপশন</span>
                <span className="block text-xs text-[#6B5A40]">সাধারণত লাগে না: নাম, সময় ঠিক করা, পপআপের সাইজ, নিজের HTML ডিজাইন</span>
              </span>
              <ChevronDown size={16} className={`shrink-0 text-[#6B5A40] transition ${advOpen ? "rotate-180" : ""}`} />
            </button>
            {advOpen && (
              <div className="space-y-4 border-t border-[#E3D6B8] p-3.5">
                <label className="block">
                  <span className={LABEL}>অ্যালার্টের নাম (শুধু আপনি দেখবেন)</span>
                  <input className={INPUT} value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="ফাঁকা রাখলে শিরোনাম থেকে নাম হবে" />
                </label>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="block">
                    <span className={LABEL}>কখন থেকে দেখাবে</span>
                    <input type="datetime-local" className={INPUT} value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
                    <span className="mt-1 block text-[11px] text-[#8A7753]">ফাঁকা = এখনই</span>
                  </label>
                  <label className="block">
                    <span className={LABEL}>কখন বন্ধ হবে</span>
                    <input type="datetime-local" className={INPUT} value={form.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
                    <span className="mt-1 block text-[11px] text-[#8A7753]">ফাঁকা = আপনি বন্ধ না করা পর্যন্ত</span>
                  </label>
                  <label className="block">
                    <span className={LABEL}>পপআপের সাইজ</span>
                    <select className={INPUT} value={form.width} onChange={(e) => set({ width: e.target.value as AlertWidth })}>
                      <option value="sm">ছোট</option>
                      <option value="md">মাঝারি</option>
                      <option value="lg">বড়</option>
                    </select>
                  </label>
                </div>
                <div>
                  <span className={LABEL}>ডিজাইনের ধরন</span>
                  <div className="mt-2 inline-flex rounded-lg border border-[#E3D6B8] bg-[#FBF6E8] p-1 text-sm">
                    {(["template", "html"] as AlertMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => set({ mode: m, html: m === "html" && !form.html ? SAMPLE_CUSTOM_HTML : form.html })}
                        className={`rounded-md px-3 py-1.5 font-semibold transition ${
                          form.mode === m ? "bg-[#3B2F1E] text-[#F5E9C8]" : "text-[#6B5A40] hover:bg-[#F5EBD0]"
                        }`}
                      >
                        {m === "template" ? "রেডিমেড ডিজাইন" : "নিজের HTML"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ---------------- send bar ---------------- */}
          <div className="rounded-xl border border-[#E3D6B8] bg-white p-4">
            <p className="text-sm text-[#3B2F1E]">
              {previewEmpty ? (
                <span className="text-[#6B5A40]">আগে ওপর থেকে একটি বার্তা বাছুন, অথবা শিরোনাম ও বার্তা লিখুন।</span>
              ) : (
                <>
                  <span className="font-bold">পাঠানো হবে:</span> {selectedAudience} · {repeatShort}
                </>
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSend}
                className="inline-flex items-center gap-2 rounded-lg bg-[#DC2626] px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#B91C1C] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "save" ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {editingId ? "পরিবর্তন সেভ করুন" : "ইউজারদের পাঠান"}
              </button>
              <button type="button" className={`${BTN} px-4 py-3`} disabled={previewEmpty} onClick={() => setFullPreview(true)}>
                <Eye size={14} /> পুরো স্ক্রিনে দেখুন
              </button>
            </div>
          </div>
        </section>

        {/* ---------------- live preview ---------------- */}
        <section className={`${CARD} xl:sticky xl:top-4 xl:self-start`}>
          <h3 className="mb-1 text-base font-bold text-[#3B2F1E]">ইউজার যেভাবে দেখবে</h3>
          <p className="mb-3 text-xs text-[#6B5A40]">আপনি যা লিখবেন, এখানে সাথে সাথে দেখা যাবে।</p>
          <div className="rounded-xl bg-[#2B2113]/80 p-4 sm:p-6">
            {previewEmpty ? (
              <p className="py-16 text-center text-sm text-[#E8D4A2]">বার্তা বাছুন বা লিখুন, এখানে প্রিভিউ আসবে।</p>
            ) : (
              <div className="mx-auto" style={{ maxWidth: ALERT_WIDTH_PX[form.width] }}>
                <AlertHtmlView html={previewHtml} />
              </div>
            )}
          </div>
          <p className="mt-2 text-[11px] text-[#8A7753]">নমুনা নাম (রহিম) দেখানো হচ্ছে। প্রতিটি ইউজার নিজের নাম দেখবে।</p>
        </section>
      </div>

      {/* ---------------- list ---------------- */}
      <section className={CARD}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-[#3B2F1E]">আগে পাঠানো অ্যালার্ট</h3>
            <p className="text-xs text-[#6B5A40]">
              <b>চালু আছে</b> লেখা অ্যালার্ট ইউজাররা এখনো দেখছে। কাজ শেষ হলে <b>বন্ধ করুন</b> চাপুন।
            </p>
          </div>
          <button type="button" className={BTN} onClick={() => void load()}>রিফ্রেশ</button>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-[#6B5A40]"><Loader2 size={16} className="animate-spin" /> লোড হচ্ছে…</div>
        ) : alerts.length === 0 ? (
          <p className="py-6 text-sm text-[#6B5A40]">এখনো কোনো অ্যালার্ট পাঠানো হয়নি। ওপর থেকে প্রথমটি তৈরি করুন।</p>
        ) : (
          <ul className="space-y-3">
            {alerts.map((row) => {
              const status = statusOf(row);
              const working = busy.endsWith(`:${row.id}`);
              return (
                <li key={row.id} className="rounded-xl border border-[#E3D6B8] bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-[#3B2F1E]">{row.name}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${status.tone}`}>{status.label}</span>
                        <span className="rounded-full bg-[#F5EBD0] px-2 py-0.5 text-[11px] font-semibold text-[#6B5A40]">
                          {row.mode === "html" ? "নিজের HTML" : KIND_BN[(row.template.kind as AlertKind) || "info"]}
                        </span>
                        <span className="rounded-full bg-[#F5EBD0] px-2 py-0.5 text-[11px] font-semibold text-[#6B5A40]">
                          {row.repeat === "daily" ? "প্রতিদিন" : "একবার"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[#6B5A40]">
                        কাকে: {audienceOptions.find((o) => o.key === row.audience)?.label.replace(/ \(\d+\)$/, "")}
                        {row.audience === "specific" ? ` (${row.targetCount} জন)` : ""}
                        {row.startsAt ? ` · শুরু ${fmt(row.startsAt)}` : ""}
                        {row.expiresAt ? ` · শেষ ${fmt(row.expiresAt)}` : ""}
                      </p>
                      <p className="mt-2 text-xs font-semibold text-[#3B2F1E]">
                        {row.targetCount} জনের মধ্যে দেখেছে {row.stats.shown} জন · বন্ধ করেছে {row.stats.dismissed} জন · বাটনে চেপেছে {row.stats.clicked} জন
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={BTN}
                        disabled={working}
                        onClick={() => void act(row.id, "toggle", { active: !row.active }, row.active ? "অ্যালার্ট বন্ধ করা হয়েছে।" : "অ্যালার্ট আবার চালু হয়েছে।")}
                      >
                        {row.active ? <><Pause size={13} /> বন্ধ করুন</> : <><Play size={13} /> আবার চালু করুন</>}
                      </button>
                      <button
                        type="button"
                        className={BTN}
                        disabled={working}
                        onClick={() => {
                          if (window.confirm("যারা আগে বন্ধ করে দিয়েছে তাদেরসহ সবাইকে এটা আবার দেখানো হবে। ঠিক আছে?")) {
                            void act(row.id, "resend", {}, "হয়ে গেছে। এই অডিয়েন্সের সবাই আবার এটা দেখবে।");
                          }
                        }}
                      >
                        <RotateCcw size={13} /> আবার পাঠান
                      </button>
                      <button type="button" className={BTN} disabled={working} onClick={() => edit(row)}><Pencil size={13} /> এডিট</button>
                      <button type="button" className={BTN} disabled={working} onClick={() => edit(row, true)}><Copy size={13} /> কপি করে নতুন</button>
                      <button
                        type="button"
                        className={`${BTN} text-red-700`}
                        disabled={working}
                        onClick={() => {
                          if (window.confirm(`“${row.name}” এবং এর হিস্ট্রি মুছে ফেলবেন?`)) void act(row.id, "delete", {}, "অ্যালার্ট মুছে ফেলা হয়েছে।");
                        }}
                      >
                        <Trash2 size={13} /> মুছুন
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {fullPreview && (
        <div
          className="fixed inset-0 z-[120] grid place-items-center bg-[#2B2113]/65 p-4 backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && setFullPreview(false)}
        >
          <div className="relative max-h-[calc(100dvh-32px)] w-full overflow-y-auto" style={{ maxWidth: ALERT_WIDTH_PX[form.width] }}>
            <button
              type="button"
              aria-label="প্রিভিউ বন্ধ করুন"
              onClick={() => setFullPreview(false)}
              className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full bg-white/80 text-[#8A7753] hover:bg-white"
            >
              <X size={16} />
            </button>
            <AlertHtmlView html={previewHtml} onClose={() => setFullPreview(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
