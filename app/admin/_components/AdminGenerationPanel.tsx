"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, LoaderCircle, RefreshCw, Search, ShieldAlert, X } from "lucide-react";
import { getClientAuthHeaders } from "@/lib/clientAuth";

type Item = {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  loginCount: number;
  lastLoginAt: string | null;
  isBanned: boolean;
  allowed: number;
  blocked: number;
  failed: number;
  plan: "admin" | "premium" | "manual" | "expired" | "free";
  planUntil: string | null;
  isAdminUser: boolean;
  lastHour: number;
  ipCount: number;
  lastAt: string | null;
  suspicious: boolean;
  reasons: string[];
  limitedNow: boolean;
  limitKind: "hourly" | "daily" | "both" | null;
  unlockAt: string | null;
};

type SharedIp = { ip: string; count: number; users: Pick<Item, "id" | "fullName" | "email" | "phoneNumber">[] };

type Data = {
  hours: number;
  limits: { hourly: number; daily: number };
  totals: { allowed: number; blocked: number; failed: number; users: number };
  series: { label: string; ok: number; failed: number }[];
  items: Item[];
  sharedIps: SharedIp[];
};

type Detail = {
  ips: { ip: string; count: number; lastAt: string; userAgent: string }[];
  recent: { id: string; route: string; ip: string; userAgent: string; outcome: "allowed" | "blocked"; createdAt: string }[];
};

const CARD =
  "rounded-2xl border border-[#E3D6B8] bg-[#FBF6E8] shadow-[0_10px_28px_-20px_rgba(59,47,30,0.45)]";
const TH = "px-4 py-3 text-[12px] font-semibold text-[#7A6A50]";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "23 min" / "2h 10m" until the account can generate again; null once the time has passed.
function remaining(unlockAt: string, nowMs: number) {
  const ms = new Date(unlockAt).getTime() - nowMs;
  if (ms <= 0) return null;
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const PLAN_BADGE: Record<Item["plan"], { text: string; cls: string }> = {
  admin: { text: "Admin", cls: "bg-slate-200 text-slate-700" },
  premium: { text: "Premium", cls: "bg-emerald-100 text-emerald-700" },
  manual: { text: "Given by admin", cls: "bg-sky-100 text-sky-700" },
  expired: { text: "Expired", cls: "bg-amber-100 text-amber-800" },
  free: { text: "Free", cls: "bg-stone-200 text-stone-700" },
};

type SortKey = "total" | "lastHour" | "failed" | "ips" | "recent";
const SORT_LABEL: Record<SortKey, string> = {
  total: "Most images",
  lastHour: "Most in last hour",
  failed: "Most failed",
  ips: "Most IPs",
  recent: "Latest activity",
};

// Pictures per hour / per day. Green = delivered, red = failed.
function Chart({ series, perDay }: { series: Data["series"]; perDay: boolean }) {
  const max = Math.max(1, ...series.map((x) => x.ok + x.failed));
  const total = series.reduce((n, x) => n + x.ok + x.failed, 0);
  return (
    <div className="mt-5 rounded-xl border border-[#E3D6B8] bg-[#FFFDF6] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#3B2F1E]">{perDay ? "Images per day" : "Images per hour (Bangladesh time)"}</h3>
        <p className="text-xs text-[#7A6A50]">
          <span className="mr-3 inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> delivered</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-rose-500" /> failed</span>
        </p>
      </div>
      {total === 0 ? (
        <p className="py-6 text-center text-sm text-[#7A6A50]">No images in this period.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <div className="flex h-36 min-w-[560px] items-end gap-1">
            {series.map((b, i) => {
              const sum = b.ok + b.failed;
              const h = Math.round((sum / max) * 100);
              return (
                <div key={`${b.label}-${i}`} className="flex h-full flex-1 flex-col items-center justify-end" title={`${b.label}: ${b.ok} delivered, ${b.failed} failed`}>
                  <span className="mb-0.5 text-[10px] tabular-nums text-[#7A6A50]">{sum > 0 ? sum : ""}</span>
                  <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: `${h}%`, minHeight: sum > 0 ? 3 : 0 }}>
                    {b.failed > 0 && <div className="bg-rose-500" style={{ flex: b.failed }} />}
                    {b.ok > 0 && <div className="bg-emerald-500" style={{ flex: b.ok }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex min-w-[560px] gap-1">
            {series.map((b, i) => (
              <span key={`${b.label}-l${i}`} className="flex-1 text-center text-[10px] text-[#A8987A]">
                {perDay || i % 3 === 0 ? b.label : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminGenerationPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [hours, setHours] = useState<24 | 168>(24);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [onlySuspicious, setOnlySuspicious] = useState(false);

  // Keep the "opens in" countdown fresh without reloading the list.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/generation-activity?hours=${hours}`, {
        headers: getClientAuthHeaders(),
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || "Could not load.");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const openDetail = async (item: Item) => {
    setSelected(item);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/generation-activity?userId=${item.id}`, {
        headers: getClientAuthHeaders(),
        cache: "no-store",
      });
      const json = await res.json();
      if (json.success) setDetail(json);
    } finally {
      setDetailLoading(false);
    }
  };

  const blockTools = async (item: { id: string; fullName: string }) => {
    if (!window.confirm(`Block all tools for ${item.fullName}? You can restore access from Users → Manage access.`)) return;
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/admin/users/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getClientAuthHeaders() },
        body: JSON.stringify({ action: "ban", reason: "Unusual image generation activity" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.message || "Could not block.");
      await load();
      setSelected((cur) => (cur && cur.id === item.id ? { ...cur, isBanned: true } : cur));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not block.");
    } finally {
      setBusyId("");
    }
  };

  const items = data?.items || [];
  const suspicious = items.filter((i) => i.suspicious);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = items.filter((i) => {
      if (onlySuspicious && !i.suspicious) return false;
      if (!q) return true;
      return `${i.fullName} ${i.email} ${i.phoneNumber}`.toLowerCase().includes(q);
    });
    const time = (v: string | null) => (v ? new Date(v).getTime() : 0);
    return [...list].sort((a, b) => {
      if (sortKey === "lastHour") return b.lastHour - a.lastHour || b.allowed - a.allowed;
      if (sortKey === "failed") return b.failed - a.failed || b.allowed - a.allowed;
      if (sortKey === "ips") return b.ipCount - a.ipCount || b.allowed - a.allowed;
      if (sortKey === "recent") return time(b.lastAt) - time(a.lastAt);
      return b.allowed - a.allowed || b.blocked - a.blocked;
    });
  }, [items, query, sortKey, onlySuspicious]);

  return (
    <div className="space-y-6">
      <section className={`${CARD} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[#3B2F1E]">Image generation activity</h2>
            <p className="mt-1 text-sm text-[#7A6A50]">
              Who is generating images, from which IP, and how often. Limit per account:{" "}
              {data ? `${data.limits.hourly}/hour, ${data.limits.daily}/day` : "…"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {([24, 168] as const).map((h) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold ${hours === h ? "border-[#DC2626] bg-[#DC2626] text-white" : "border-[#D8C9A6] bg-[#FFFDF6] text-[#3B2F1E]"}`}
              >
                {h === 24 ? "Last 24 hours" : "Last 7 days"}
              </button>
            ))}
            <button
              onClick={() => void load()}
              className="rounded-lg border border-[#D8C9A6] bg-[#FFFDF6] p-2.5 text-[#3B2F1E]"
              aria-label="Refresh"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["Images generated", data?.totals.allowed ?? 0],
            ["Failed images", data?.totals.failed ?? 0],
            ["Blocked by limit", data?.totals.blocked ?? 0],
            ["Users generating", data?.totals.users ?? 0],
            ["Suspicious accounts", suspicious.length],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-[#E3D6B8] bg-[#FFFDF6] p-4">
              <div className="text-xs font-medium text-[#7A6A50]">{label}</div>
              <div className="mt-2 text-2xl font-semibold tabular-nums text-[#3B2F1E]">{value}</div>
            </div>
          ))}
        </div>
        {data?.series && <Chart series={data.series} perDay={hours === 168} />}
        {error && <p className="mt-4 text-sm text-rose-700">{error}</p>}
      </section>

      <section className={`${CARD} overflow-hidden`}>
        <div className="flex items-center gap-2 border-b border-[#E3D6B8] px-5 py-4 text-sm font-semibold text-[#3B2F1E]">
          <ShieldAlert size={16} className="text-[#DC2626]" /> Accounts by generation count
          <span className="font-normal text-[#7A6A50]">({visible.length}{visible.length !== items.length ? ` of ${items.length}` : ""})</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#E3D6B8] px-5 py-3">
          <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-[#D8C9A6] bg-[#FFFDF6] px-3 py-2 text-sm text-[#3B2F1E]">
            <Search size={14} className="text-[#7A6A50]" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email or phone"
              className="w-full bg-transparent outline-none placeholder:text-[#A8987A]"
            />
          </label>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            aria-label="Sort"
            className="rounded-lg border border-[#D8C9A6] bg-[#FFFDF6] px-3 py-2 text-sm font-semibold text-[#3B2F1E]"
          >
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>{SORT_LABEL[k]}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setOnlySuspicious((v) => !v)}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold ${onlySuspicious ? "border-rose-300 bg-rose-100 text-rose-800" : "border-[#D8C9A6] bg-[#FFFDF6] text-[#3B2F1E]"}`}
          >
            Only suspicious ({suspicious.length})
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[#E3D6B8]">
                <th className={TH}>User</th>
                <th className={TH}>Last hour</th>
                <th className={TH}>Total</th>
                <th className={TH}>Failed</th>
                <th className={TH}>Blocked</th>
                <th className={TH}>Limit status</th>
                <th className={TH}>IPs</th>
                <th className={TH}>Logins</th>
                <th className={TH}>Last generated</th>
                <th className={TH}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={10} className="px-5 py-10 text-center text-sm text-[#7A6A50]"><LoaderCircle className="mx-auto animate-spin" size={18} /></td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={10} className="px-5 py-10 text-center text-sm text-[#7A6A50]">{items.length === 0 ? "No generations recorded in this period yet." : "No account matches your search."}</td></tr>
              ) : (
                visible.map((item) => (
                  <tr key={item.id} className={`border-b border-[#EFE4C8] ${item.suspicious ? "bg-rose-50/60" : ""}`}>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-[#3B2F1E]">{item.fullName}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${(PLAN_BADGE[item.plan] ?? PLAN_BADGE.free).cls}`}>{(PLAN_BADGE[item.plan] ?? PLAN_BADGE.free).text}</span>
                      </div>
                      <div className="text-xs text-[#7A6A50]">{item.email || item.phoneNumber}</div>
                      {item.planUntil && <div className="text-[11px] text-[#A8987A]">until {fmt(item.planUntil)}</div>}
                      {item.suspicious && (
                        <div className="mt-1 text-[11px] font-semibold text-rose-700">⚠ {item.reasons.join(" · ")}</div>
                      )}
                      {item.isBanned && <div className="mt-1 text-[11px] font-semibold text-rose-700">Tools blocked</div>}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold tabular-nums text-[#3B2F1E]">{item.lastHour}</td>
                    <td className="px-4 py-3 text-sm font-semibold tabular-nums text-[#3B2F1E]">{item.allowed}</td>
                    <td className={`px-4 py-3 text-sm tabular-nums ${item.failed > 0 ? "font-semibold text-rose-700" : "text-[#3B2F1E]"}`}>{item.failed}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#3B2F1E]">{item.blocked}</td>
                    <td className="px-4 py-3">
                      {(() => {
                        const left = item.limitedNow && item.unlockAt ? remaining(item.unlockAt, nowMs) : null;
                        if (left && item.unlockAt) {
                          return (
                            <div>
                              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">Locked</span>
                              <div className="mt-1 text-xs font-semibold text-[#3B2F1E]">Opens in {left}</div>
                              <div className="text-[11px] text-[#7A6A50]">
                                at {fmt(item.unlockAt)} · {item.limitKind === "daily" ? "daily" : item.limitKind === "both" ? "hourly + daily" : "hourly"} limit
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div>
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Open</span>
                            <div className="mt-1 text-[11px] text-[#7A6A50]">{item.lastHour}/{data?.limits.hourly ?? 0} this hour</div>
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#3B2F1E]">{item.ipCount}</td>
                    <td className="px-4 py-3 text-sm text-[#3B2F1E]">
                      <div className="tabular-nums">{item.loginCount} times</div>
                      <div className="text-xs text-[#7A6A50]">last: {fmt(item.lastLoginAt)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-[#7A6A50]">{fmt(item.lastAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => void openDetail(item)} className="rounded-lg border border-[#D8C9A6] bg-[#FFFDF6] px-3 py-1.5 text-xs font-semibold text-[#3B2F1E]">
                          Details
                        </button>
                        {!item.isBanned && (
                          <button
                            disabled={busyId === item.id}
                            onClick={() => void blockTools(item)}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 disabled:opacity-50"
                          >
                            <Ban size={12} /> Block
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {data && data.sharedIps.length > 0 && (
        <section className={`${CARD} p-5`}>
          <h3 className="text-sm font-semibold text-[#3B2F1E]">Same IP used by multiple accounts</h3>
          <p className="mt-1 text-xs text-[#7A6A50]">One person may be using several accounts (family or a shared shop connection can also look like this).</p>
          <div className="mt-3 space-y-2">
            {data.sharedIps.map((row) => (
              <div key={row.ip} className="rounded-xl border border-[#E3D6B8] bg-[#FFFDF6] p-3 text-sm">
                <div className="font-mono text-[#3B2F1E]">{row.ip} <span className="font-sans text-xs text-[#7A6A50]">· {row.count} generations</span></div>
                <div className="mt-1 text-xs text-[#7A6A50]">{row.users.map((u) => `${u.fullName} (${u.email || u.phoneNumber})`).join("  •  ")}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {selected && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#2A2118]/60 px-4 py-6 backdrop-blur-sm" onClick={() => setSelected(null)}>
          <div className={`${CARD} max-h-[85vh] w-full max-w-3xl overflow-y-auto p-6`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-[#3B2F1E]">{selected.fullName}</h3>
                <p className="text-sm text-[#7A6A50]">{selected.email} {selected.phoneNumber && `· ${selected.phoneNumber}`}</p>
                <p className="mt-1 text-xs text-[#7A6A50]">Logged in {selected.loginCount} times · last login {fmt(selected.lastLoginAt)}</p>
              </div>
              <button onClick={() => setSelected(null)} aria-label="Close" className="rounded-lg p-1.5 text-[#7A6A50] hover:bg-black/5"><X size={18} /></button>
            </div>

            {detailLoading || !detail ? (
              <div className="py-10 text-center"><LoaderCircle className="mx-auto animate-spin" size={18} /></div>
            ) : (
              <>
                <h4 className="mt-5 text-sm font-semibold text-[#3B2F1E]">IP addresses (last 7 days)</h4>
                <div className="mt-2 space-y-1.5">
                  {detail.ips.map((row) => (
                    <div key={row.ip} className="rounded-lg border border-[#E3D6B8] bg-[#FFFDF6] px-3 py-2 text-sm">
                      <span className="font-mono text-[#3B2F1E]">{row.ip}</span>
                      <span className="ml-2 text-xs text-[#7A6A50]">{row.count} times · last {fmt(row.lastAt)}</span>
                      <div className="truncate text-[11px] text-[#A8987A]">{row.userAgent}</div>
                    </div>
                  ))}
                </div>
                <h4 className="mt-5 text-sm font-semibold text-[#3B2F1E]">Recent attempts</h4>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-xs">
                    <tbody>
                      {detail.recent.map((r) => (
                        <tr key={r.id} className="border-b border-[#EFE4C8]">
                          <td className="py-1.5 pr-3 text-[#7A6A50]">{fmt(r.createdAt)}</td>
                          <td className="py-1.5 pr-3 font-mono text-[#3B2F1E]">{r.ip}</td>
                          <td className="py-1.5 pr-3 text-[#7A6A50]">{r.route}</td>
                          <td className={`py-1.5 font-semibold ${r.outcome === "blocked" ? "text-rose-700" : "text-emerald-700"}`}>{r.outcome === "blocked" ? "Blocked (limit)" : "Generated"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {!selected.isBanned && (
              <button
                disabled={busyId === selected.id}
                onClick={() => void blockTools(selected)}
                className="mt-5 inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 disabled:opacity-50"
              >
                <Ban size={14} /> Block all tools
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
