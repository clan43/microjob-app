"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Copy,
  Eye,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Trash2,
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

function statusOf(row: AlertRow): { label: string; tone: string } {
  const now = Date.now();
  if (!row.active) return { label: "Stopped", tone: "bg-stone-200 text-stone-700" };
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return { label: "Expired", tone: "bg-stone-200 text-stone-700" };
  if (row.startsAt && new Date(row.startsAt).getTime() > now) return { label: "Scheduled", tone: "bg-blue-100 text-blue-800" };
  return { label: "Live", tone: "bg-green-100 text-green-800" };
}

export default function UserAlertsPanel() {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fullPreview, setFullPreview] = useState(false);

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
  };

  const payload = (extra: Record<string, unknown> = {}) => ({
    name: form.name,
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
        (editingId ? "Alert updated." : "Alert is live. Users will see it the next time they open or move around the site.") +
          (missing.length ? ` Not found (skipped): ${missing.join(", ")}` : ""),
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

  const usePreset = (id: string) => {
    const preset = ALERT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setForm((f) => ({
      ...f,
      name: f.name || preset.label,
      mode: "template",
      template: { ...preset.template },
      audience: preset.audience,
      repeat: preset.repeat,
    }));
  };

  const audienceOptions: Array<{ key: AlertAudience; label: string }> = [
    { key: "all", label: `All users${counts ? ` (${counts.all})` : ""}` },
    { key: "subscribed", label: `Active subscribers${counts ? ` (${counts.subscribed})` : ""}` },
    { key: "not_subscribed", label: `Not subscribed${counts ? ` (${counts.not_subscribed})` : ""}` },
    { key: "specific", label: "Specific users (by email)" },
  ];

  return (
    <div className="space-y-6">
      <section className={CARD}>
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#3B2F1E] text-[#F2CB7A]">
            <Bell size={18} />
          </span>
          <div>
            <h2 className="text-lg font-bold text-[#3B2F1E]">User Alerts</h2>
            <p className="text-sm text-[#6B5A40]">
              Send a popup message to your users, like the paid-access or file-delete popups. Pick a ready-made design or
              paste your own HTML. Every user is tracked separately, so each one sees it once (or once a day) until they
              close it.
            </p>
          </div>
        </div>
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        {/* ---------------- composer ---------------- */}
        <section className={`${CARD} space-y-5`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold text-[#3B2F1E]">{editingId ? "Edit alert" : "New alert"}</h3>
            {editingId && (
              <button type="button" className={BTN} onClick={reset}>
                <X size={14} /> Cancel editing
              </button>
            )}
          </div>

          <div>
            <span className={LABEL}>Quick start</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {ALERT_PRESETS.map((p) => (
                <button key={p.id} type="button" className={BTN} onClick={() => usePreset(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className={LABEL}>Alert name (only you see this)</span>
            <input className={INPUT} value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Eid offer 2026" />
          </label>

          <div>
            <span className={LABEL}>Design</span>
            <div className="mt-2 inline-flex rounded-lg border border-[#E3D6B8] bg-white p-1 text-sm">
              {(["template", "html"] as AlertMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set({ mode: m, html: m === "html" && !form.html ? SAMPLE_CUSTOM_HTML : form.html })}
                  className={`rounded-md px-3 py-1.5 font-semibold transition ${
                    form.mode === m ? "bg-[#3B2F1E] text-[#F5E9C8]" : "text-[#6B5A40] hover:bg-[#F5EBD0]"
                  }`}
                >
                  {m === "template" ? "Ready-made design" : "Custom HTML"}
                </button>
              ))}
            </div>
          </div>

          {form.mode === "template" ? (
            <div className="space-y-4">
              <div>
                <span className={LABEL}>Type</span>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {ALERT_KIND_KEYS.map((k: AlertKind) => {
                    const s = ALERT_KINDS[k];
                    const on = form.template.kind === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setTpl({ kind: k })}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-semibold transition ${
                          on ? "border-[#3B2F1E] bg-white ring-2 ring-[#3B2F1E]/15" : "border-[#E3D6B8] bg-white hover:bg-[#F5EBD0]"
                        }`}
                      >
                        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.accent }} />
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="block">
                <span className={LABEL}>Title</span>
                <input className={INPUT} value={form.template.title} maxLength={TEMPLATE_MAX.title} onChange={(e) => setTpl({ title: e.target.value })} />
              </label>
              <label className="block">
                <span className={LABEL}>Message</span>
                <textarea className={`${INPUT} min-h-[110px] resize-y`} value={form.template.message} maxLength={TEMPLATE_MAX.message} onChange={(e) => setTpl({ message: e.target.value })} />
                <span className="mt-1 block text-[11px] text-[#8A7753]">
                  Use {"{{firstName}}"}, {"{{name}}"} or {"{{email}}"} to personalise it for every user.
                </span>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className={LABEL}>Button text (optional)</span>
                  <input className={INPUT} value={form.template.ctaText} maxLength={TEMPLATE_MAX.ctaText} onChange={(e) => setTpl({ ctaText: e.target.value })} />
                </label>
                <label className="block">
                  <span className={LABEL}>Button link</span>
                  <input className={INPUT} value={form.template.ctaUrl} maxLength={TEMPLATE_MAX.ctaUrl} onChange={(e) => setTpl({ ctaUrl: e.target.value })} placeholder="/subscription or https://..." />
                </label>
              </div>
              <label className="block">
                <span className={LABEL}>Close button text (optional)</span>
                <input className={INPUT} value={form.template.closeText} maxLength={TEMPLATE_MAX.closeText} onChange={(e) => setTpl({ closeText: e.target.value })} placeholder="বন্ধ করুন" />
              </label>
            </div>
          ) : (
            <label className="block">
              <span className={LABEL}>HTML code</span>
              <textarea
                className={`${INPUT} min-h-[260px] resize-y font-mono text-[12.5px]`}
                value={form.html}
                maxLength={HTML_MAX}
                spellCheck={false}
                onChange={(e) => set({ html: e.target.value })}
              />
              <span className="mt-1 block text-[11px] leading-relaxed text-[#8A7753]">
                Write the full design with inline styles or a {"<style>"} block. Add <code>data-alert-close</code> to any
                button to close the popup. Placeholders: {"{{firstName}}"}, {"{{name}}"}, {"{{email}}"}. Scripts, forms and
                iframes are removed for safety.
              </span>
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={LABEL}>Send to</span>
              <select className={INPUT} value={form.audience} onChange={(e) => set({ audience: e.target.value as AlertAudience })}>
                {audienceOptions.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={LABEL}>How often</span>
              <select className={INPUT} value={form.repeat} onChange={(e) => set({ repeat: e.target.value as AlertRepeat })}>
                <option value="once">Once, until the user closes it</option>
                <option value="daily">Every day until it ends</option>
              </select>
            </label>
          </div>

          {form.audience === "specific" && (
            <label className="block">
              <span className={LABEL}>User emails (one per line or comma separated)</span>
              <textarea className={`${INPUT} min-h-[90px] resize-y`} value={form.targetEmails} onChange={(e) => set({ targetEmails: e.target.value })} placeholder={"user1@gmail.com\nuser2@gmail.com"} />
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className={LABEL}>Start (optional)</span>
              <input type="datetime-local" className={INPUT} value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
            </label>
            <label className="block">
              <span className={LABEL}>End (optional)</span>
              <input type="datetime-local" className={INPUT} value={form.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
            </label>
            <label className="block">
              <span className={LABEL}>Popup width</span>
              <select className={INPUT} value={form.width} onChange={(e) => set({ width: e.target.value as AlertWidth })}>
                <option value="sm">Small</option>
                <option value="md">Medium</option>
                <option value="lg">Large</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy === "save"}
              className="inline-flex items-center gap-2 rounded-lg bg-[#DC2626] px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#B91C1C] disabled:opacity-60"
            >
              {busy === "save" ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              {editingId ? "Save changes" : "Send to users"}
            </button>
            <button type="button" className={BTN} disabled={previewEmpty} onClick={() => setFullPreview(true)}>
              <Eye size={14} /> Full preview
            </button>
          </div>
        </section>

        {/* ---------------- live preview ---------------- */}
        <section className={`${CARD} xl:sticky xl:top-4 xl:self-start`}>
          <h3 className="mb-3 text-base font-bold text-[#3B2F1E]">Live preview</h3>
          <div className="rounded-xl bg-[#2B2113]/80 p-4 sm:p-6">
            {previewEmpty ? (
              <p className="py-16 text-center text-sm text-[#E8D4A2]">Your popup preview appears here as you type.</p>
            ) : (
              <div className="mx-auto" style={{ maxWidth: ALERT_WIDTH_PX[form.width] }}>
                <AlertHtmlView html={previewHtml} />
              </div>
            )}
          </div>
          <p className="mt-2 text-[11px] text-[#8A7753]">Shown with a sample name (রহিম). Each user sees their own name.</p>
        </section>
      </div>

      {/* ---------------- list ---------------- */}
      <section className={CARD}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-[#3B2F1E]">Sent alerts</h3>
          <button type="button" className={BTN} onClick={() => void load()}>Refresh</button>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-[#6B5A40]"><Loader2 size={16} className="animate-spin" /> Loading…</div>
        ) : alerts.length === 0 ? (
          <p className="py-6 text-sm text-[#6B5A40]">No alerts yet. Create your first one above.</p>
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
                          {row.mode === "html" ? "Custom HTML" : ALERT_KINDS[(row.template.kind as AlertKind) || "info"]?.label}
                        </span>
                        <span className="rounded-full bg-[#F5EBD0] px-2 py-0.5 text-[11px] font-semibold text-[#6B5A40]">
                          {row.repeat === "daily" ? "Daily" : "Once"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[#6B5A40]">
                        To: {audienceOptions.find((o) => o.key === row.audience)?.label.replace(/ \(\d+\)$/, "")}
                        {row.audience === "specific" ? ` (${row.targetCount})` : ""}
                        {row.startsAt ? ` · from ${fmt(row.startsAt)}` : ""}
                        {row.expiresAt ? ` · until ${fmt(row.expiresAt)}` : ""}
                      </p>
                      <p className="mt-2 text-xs font-semibold text-[#3B2F1E]">
                        Seen by {row.stats.shown} of {row.targetCount} · Closed {row.stats.dismissed} · Clicked button {row.stats.clicked}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={BTN} disabled={working} onClick={() => edit(row)}><Pencil size={13} /> Edit</button>
                      <button type="button" className={BTN} disabled={working} onClick={() => edit(row, true)}><Copy size={13} /> Duplicate</button>
                      <button
                        type="button"
                        className={BTN}
                        disabled={working}
                        onClick={() => void act(row.id, "toggle", { active: !row.active }, row.active ? "Alert stopped." : "Alert resumed.")}
                      >
                        {row.active ? <><Pause size={13} /> Stop</> : <><Play size={13} /> Resume</>}
                      </button>
                      <button
                        type="button"
                        className={BTN}
                        disabled={working}
                        onClick={() => {
                          if (window.confirm("Show this alert again to everyone, even users who already closed it?")) {
                            void act(row.id, "resend", {}, "Done. Everyone in the audience will see it again.");
                          }
                        }}
                      >
                        <RotateCcw size={13} /> Send again
                      </button>
                      <button
                        type="button"
                        className={`${BTN} text-red-700`}
                        disabled={working}
                        onClick={() => {
                          if (window.confirm(`Delete "${row.name}" and its history?`)) void act(row.id, "delete", {}, "Alert deleted.");
                        }}
                      >
                        <Trash2 size={13} /> Delete
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
              aria-label="Close preview"
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
