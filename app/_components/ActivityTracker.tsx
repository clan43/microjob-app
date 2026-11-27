"use client";

import { useEffect } from "react";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/presenceConstants";

/**
 * Live presence: a signed-in user counts as ONLINE for as long as the site is open in a browser
 * tab, and goes OFFLINE as soon as the tab/browser is closed.
 *
 * - A small heartbeat is sent every PRESENCE_HEARTBEAT_MS while the tab is open. It does not matter whether
 *   the user is clicking, reading or idle - an open tab is an online user.
 * - When the tab is closed, reloaded away or the browser quits, a "leave" request is sent
 *   immediately, so the admin sees the user offline within seconds instead of waiting for a timeout.
 * - If the leave request never arrives (power cut, crash, network loss) the server-side
 *   PRESENCE_STALE_AFTER_MS window expires the session shortly after the last heartbeat.
 *
 * It does not report page paths, click targets, or any screen/input content - only "this user is here".
 */
const SESSION_KEY = "sohojhub:presence-session-id";
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._:-]{16,120}$/;

type AuthHeaders = Record<string, string>;

function createSessionId() {
  return typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `sh-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getOrCreateSessionId() {
  try {
    const saved = window.sessionStorage.getItem(SESSION_KEY) || "";
    if (SESSION_ID_PATTERN.test(saved)) return saved;
    const next = createSessionId();
    window.sessionStorage.setItem(SESSION_KEY, next);
    return next;
  } catch {
    return createSessionId();
  }
}

function setSessionId(value: string) {
  try { window.sessionStorage.setItem(SESSION_KEY, value); } catch { /* session storage is optional */ }
}

function getClientCredentials(): AuthHeaders | null {
  try {
    const token = window.localStorage.getItem("token") || "";
    const rawUser = window.localStorage.getItem("user");
    const user = rawUser ? JSON.parse(rawUser) : null;
    if (!token || user?.role === "admin") return null;
    return { Authorization: `Bearer ${token}` };
  } catch {
    return null;
  }
}

export default function ActivityTracker() {
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let left = false; // true between "leave" and the page coming back (bfcache / tab restore)
    let sessionId = getOrCreateSessionId();

    const sendPresence = async (leave = false) => {
      if (disposed) return;
      // a heartbeat may be skipped while another one is in flight, but "leave" must always go out
      if (busy && !leave) return;
      const credentials = getClientCredentials();
      if (!credentials) return;
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        sessionId = createSessionId();
        setSessionId(sessionId);
      }
      busy = !leave;
      try {
        await fetch("/api/auth/presence/update", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          keepalive: leave, // lets the request finish even while the page is being torn down
          headers: { "Content-Type": "application/json", ...credentials },
          body: JSON.stringify({ sessionId, leave }),
        });
      } catch {
        // Presence is best-effort; the short server-side expiry cleans stale sessions.
      } finally {
        if (!leave) busy = false;
      }
    };

    const heartbeat = () => {
      if (left) return;
      void sendPresence();
    };
    const comeBack = () => {
      left = false;
      void sendPresence();
    };
    const goOffline = () => {
      if (left) return;
      left = true;
      void sendPresence(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") comeBack();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) comeBack();
    };
    const onAuthChanged = () => {
      sessionId = createSessionId();
      setSessionId(sessionId);
      comeBack();
    };

    // online right away, then keep the lease fresh while the tab stays open
    void sendPresence();
    const timer = window.setInterval(heartbeat, PRESENCE_HEARTBEAT_MS);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", heartbeat);
    window.addEventListener("online", comeBack);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", goOffline);
    window.addEventListener("sohojhub:chat-presence", heartbeat);
    window.addEventListener("sohojhub:presence-stop", goOffline);
    window.addEventListener("sohojhub:auth-changed", onAuthChanged);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", heartbeat);
      window.removeEventListener("online", comeBack);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", goOffline);
      window.removeEventListener("sohojhub:chat-presence", heartbeat);
      window.removeEventListener("sohojhub:presence-stop", goOffline);
      window.removeEventListener("sohojhub:auth-changed", onAuthChanged);
    };
  }, []);

  return null;
}
