/**
 * "Online" = the user has the site open in a browser tab. The browser sends a small heartbeat every
 * PRESENCE_HEARTBEAT_MS while the tab is open (clicking or idle makes no difference) and sends an
 * immediate "leave" when the tab/browser is closed, so the user turns offline within seconds.
 * If the leave signal never arrives (crash, power or network loss) the session expires on its own
 * after PRESENCE_STALE_AFTER_MS.
 */
export const PRESENCE_HEARTBEAT_MS = 15_000;          // heartbeat while the tab is open
export const PRESENCE_ACTIVITY_REFRESH_MS = 120_000; // legacy, no longer used by ActivityTracker
export const CHAT_IDLE_CLOSE_MS = 120_000;           // chat auto-closes after 2 min without activity
export const CHAT_PRESENCE_REFRESH_MS = 60_000;      // chat re-announces at most once a minute while in use
// LIVE CHAT SPEED. Polling only runs while the browser tab is visible (see visibleInterval),
// and each poll is a tiny "messages newer than X" query, so it is fast and cheap.
export const CHAT_OPEN_POLL_MS = 1_500;              // chat open: check for new messages every 1.5s
export const CHAT_CLOSED_POLL_MS = 4_000;            // chat closed: check the unread badge every 4s
export const CHAT_FULL_SYNC_MS = 20_000;             // chat open: full reload every 20s (picks up deletions / expired photos)
export const ADMIN_CHAT_MESSAGES_POLL_MS = 1_500;    // admin: open conversation
export const ADMIN_CHAT_LIST_POLL_MS = 4_000;        // admin: user list (new message previews / unread badges)
export const ADMIN_CHAT_BADGE_POLL_MS = 5_000;       // admin: sidebar unread badge

// Fallback expiry when no "leave" arrives. Browsers slow timers in background tabs to about once a
// minute, so this stays above that to avoid false "offline" flickers.
export const PRESENCE_STALE_AFTER_MS = 90_000;
export const PRESENCE_SESSION_TTL_MS = 95_000;
