"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import AlertHtmlView from "./AlertHtmlView";

/**
 * Admin -> user popups (Admin panel -> User Alerts). Mounted once in app/layout.tsx.
 * Asks /api/user-alerts for the next message meant for this user and shows it as a popup.
 * Closing (or clicking a button inside) is saved per user on the server, so each user sees
 * a message once (or once a day for "daily" alerts) on any page and any device.
 */

// Our own server has no serverless CPU limit, so users pick up a new popup within ~30 seconds
// (a user the admin just messaged from the Users tab sees it almost right away).
const CHECK_THROTTLE_MS = 15_000;
const RECHECK_EVERY_MS = 30_000;
const UNAUTH_PAUSE_MS = 5 * 60_000;

type ActiveAlert = { id: string; html: string; width: number };

function isExcluded(pathname: string | null) {
  if (!pathname) return false;
  return (
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/forgot-password" ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/ai-editor/mobile-upload/")
  );
}

function authHeaders(): Record<string, string> {
  try {
    const token = window.localStorage.getItem("token") || "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function report(id: string, action: "shown" | "dismiss" | "click") {
  void fetch("/api/user-alerts", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ id, action }),
    keepalive: true,
  }).catch(() => undefined);
}

export default function UserAlertPopup() {
  const { locale } = useI18n();
  const pathname = usePathname();
  const [alert, setAlert] = useState<ActiveAlert | null>(null);
  const alertRef = useRef<ActiveAlert | null>(null);
  const busyRef = useRef(false);
  const lastCheckRef = useRef(0);
  const pausedUntilRef = useRef(0);
  const closedIdsRef = useRef<Set<string>>(new Set());

  const check = useCallback(async (force = false) => {
    if (busyRef.current || alertRef.current) return;
    const now = Date.now();
    if (now < pausedUntilRef.current) return;
    if (!force && now - lastCheckRef.current < CHECK_THROTTLE_MS) return;
    if (isExcluded(window.location.pathname)) return;
    busyRef.current = true;
    lastCheckRef.current = now;
    try {
      const response = await fetch("/api/user-alerts", {
        credentials: "include",
        cache: "no-store",
        headers: authHeaders(),
      });
      if (response.status === 401 || response.status === 403) {
        pausedUntilRef.current = Date.now() + UNAUTH_PAUSE_MS;
        return;
      }
      if (!response.ok) return;
      const data = await response.json().catch(() => null);
      if (!data?.show || typeof data.id !== "string" || typeof data.html !== "string") return;
      if (closedIdsRef.current.has(data.id)) return;
      const next: ActiveAlert = { id: data.id, html: data.html, width: Number(data.width) || 460 };
      alertRef.current = next;
      setAlert(next);
      report(next.id, "shown");
    } catch {
      /* offline: try again later */
    } finally {
      busyRef.current = false;
    }
  }, []);

  const close = useCallback(
    (action: "dismiss" | "click") => {
      const current = alertRef.current;
      if (!current) return;
      alertRef.current = null;
      closedIdsRef.current.add(current.id);
      setAlert(null);
      report(current.id, action);
      // another message may be waiting for this user: show it right after this one
      window.setTimeout(() => void check(true), 600);
    },
    [check],
  );

  useEffect(() => {
    if (isExcluded(pathname)) {
      alertRef.current = null;
      setAlert(null);
      return;
    }
    void check();
  }, [pathname, check]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, RECHECK_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [check]);

  useEffect(() => {
    if (!alert) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close("dismiss");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [alert, close]);

  if (!alert) return null;
  const closeLabel = locale === "bn" ? "বন্ধ করুন" : "Close";

  return (
    <div
      className="ual-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && close("dismiss")}
    >
      <div className="ual-box" style={{ width: `min(${alert.width}px, 100%)` }} role="dialog" aria-modal="true">
        <button type="button" className="ual-x" onClick={() => close("dismiss")} aria-label={closeLabel}>
          <X size={18} aria-hidden="true" />
        </button>
        <AlertHtmlView html={alert.html} onClose={() => close("dismiss")} onLink={() => close("click")} />
      </div>
      <style>{`
        .ual-backdrop {
          position: fixed; inset: 0; z-index: 2147483050;
          display: grid; place-items: center; padding: 16px;
          background: rgba(43, 33, 19, 0.58); backdrop-filter: blur(5px);
          overscroll-behavior: contain; animation: ualFade .25s ease both;
        }
        .ual-box { position: relative; max-height: calc(100dvh - 32px); overflow-y: auto; border-radius: 22px; }
        .ual-x {
          position: absolute; top: 12px; right: 12px; z-index: 5;
          width: 32px; height: 32px; border: 0; border-radius: 999px; cursor: pointer;
          display: grid; place-items: center; color: #8A7753; background: rgba(255,255,255,.7);
        }
        .ual-x:hover { background: #fff; color: #2B2113; }
        @keyframes ualFade { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .ual-backdrop { animation: none; } }
      `}</style>
    </div>
  );
}
