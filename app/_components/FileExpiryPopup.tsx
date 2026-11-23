"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, FolderOpen, X } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { refreshMyFilesData } from "@/app/my-files/myFilesData";
import { FILE_RETENTION_DAYS } from "@/app/_lib/retentionConfig";

/**
 * Warns a logged-in user before their photos are deleted automatically (see app/_lib/retentionConfig.ts).
 *  - 2-3 days before: "N files will be deleted in X days"
 *  - on the last day (less than 24 hours left): "N files will be deleted today"
 * Shown at most once per day for each level. Only a date text is stored on the device, never the file list.
 * Mounted once in app/layout.tsx.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = 3; // start warning this many days before the deletion
const START_DELAY_MS = 4_000; // let the page load first
const STORAGE_PREFIX = "sebalagbe:file-expiry-popup:";

const digitsBn = (v: number) => String(v).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]);

const COPY = {
  bn: {
    soonTitle: "ছবিগুলো শীঘ্রই মুছে যাবে!",
    soon: (n: number, d: number) =>
      `আপনার ${digitsBn(n)}টি ফাইল আর ${digitsBn(d)} দিনের মধ্যে চিরতরে ডিলিট হয়ে যাবে। এখনই ডাউনলোড করে আপনার ডিভাইসে সেভ করে রাখুন।`,
    todayTitle: "আজই ছবি মুছে যাবে!",
    today: (n: number) =>
      `আপনার ${digitsBn(n)}টি ফাইল আজই চিরতরে ডিলিট হয়ে যাবে। এখনই ডাউনলোড করে নিন, পরে আর ফিরে পাওয়া যাবে না।`,
    cta: "আমার ফাইলে গিয়ে ডাউনলোড করুন",
    close: "বন্ধ করুন",
  },
  en: {
    soonTitle: "Your photos will be deleted soon!",
    soon: (n: number, d: number) =>
      `${n} of your files will be permanently deleted in ${d} day${d === 1 ? "" : "s"}. Download them and save them on your device now.`,
    todayTitle: "Your photos are deleted today!",
    today: (n: number) =>
      `${n} of your files will be permanently deleted today. Download them now, they cannot be recovered afterwards.`,
    cta: "Go to My Files and download",
    close: "Close",
  },
} as const;

type Warning = { level: "soon" | "today"; count: number; days: number };

function dayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function looksLoggedIn(): boolean {
  try {
    return !!(window.localStorage.getItem("token") || window.localStorage.getItem("user"));
  } catch {
    return true; // cookie-only login: the server answers 401 if not logged in
  }
}

function alreadyShown(level: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${level}`) === dayKey();
  } catch {
    return false;
  }
}

function markShown(level: string): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${level}`, dayKey());
  } catch {
    // only a convenience
  }
}

function buildWarning(items: Array<{ createdAt?: string }>): Warning | null {
  const now = Date.now();
  let today = 0;
  let soon = 0;
  let soonestDays = WARN_DAYS;

  for (const item of items) {
    const created = item.createdAt ? new Date(item.createdAt).getTime() : NaN;
    if (Number.isNaN(created)) continue;
    const msLeft = created + FILE_RETENTION_DAYS * DAY_MS - now;
    if (msLeft <= DAY_MS) {
      today += 1; // less than 24 hours left (or already past, waiting for the next cleanup)
    } else if (msLeft <= WARN_DAYS * DAY_MS) {
      soon += 1;
      soonestDays = Math.min(soonestDays, Math.ceil(msLeft / DAY_MS));
    }
  }

  if (today > 0) return { level: "today", count: today, days: 0 };
  if (soon > 0) return { level: "soon", count: soon, days: soonestDays };
  return null;
}

export default function FileExpiryPopup() {
  const { locale } = useI18n();
  const pathname = usePathname();
  const copy = locale === "bn" ? COPY.bn : COPY.en;
  const [warning, setWarning] = useState<Warning | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (!looksLoggedIn()) return;
      if (alreadyShown("today") && alreadyShown("soon")) return;
      try {
        const data = await refreshMyFilesData();
        if (cancelled) return;
        const found = buildWarning([...data.files, ...data.toolFiles]);
        if (!found || alreadyShown(found.level)) return;
        setWarning(found);
      } catch {
        // not logged in or offline: nothing to warn about
      }
    }, START_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // The user is already in My Files: the page itself shows the notice.
  useEffect(() => {
    if (pathname === "/my-files" || pathname?.startsWith("/my-files/")) setWarning(null);
  }, [pathname]);

  if (!warning) return null;

  const isToday = warning.level === "today";
  const close = () => {
    markShown(warning.level);
    setWarning(null);
  };

  return (
    <div className="file-expiry-wrap" role="alert" aria-live="assertive">
      <div className={`file-expiry ${isToday ? "file-expiry-today" : ""}`}>
        <button type="button" className="file-expiry-close" onClick={close} aria-label={copy.close}>
          <X size={16} aria-hidden="true" />
        </button>
        <div className="file-expiry-body">
          <span className="file-expiry-icon" aria-hidden="true">
            <AlertTriangle size={22} />
          </span>
          <div className="file-expiry-text">
            <p className="file-expiry-title">{isToday ? copy.todayTitle : copy.soonTitle}</p>
            <p className="file-expiry-desc">
              {isToday ? copy.today(warning.count) : copy.soon(warning.count, warning.days)}
            </p>
          </div>
        </div>
        <Link href="/my-files" className="file-expiry-cta" onClick={close} prefetch>
          <FolderOpen size={16} aria-hidden="true" />
          <span>{copy.cta}</span>
        </Link>
      </div>

      <style>{`
        .file-expiry-wrap {
          position: fixed;
          top: 16px;
          left: 50%;
          transform: translateX(-50%);
          width: min(440px, calc(100vw - 24px));
          z-index: 2147483000;
          pointer-events: none;
        }
        .file-expiry {
          position: relative;
          pointer-events: auto;
          padding: 16px 16px 16px;
          border-radius: 18px;
          border: 1px solid #F0D9A8;
          background: #FFFBF0;
          box-shadow: 0 18px 44px rgba(59, 47, 30, 0.28), 0 2px 6px rgba(59, 47, 30, 0.12);
          animation: fileExpiryIn 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .file-expiry-today { border-color: #F5B5B5; background: #FFF5F5; }
        .file-expiry-body { display: flex; align-items: flex-start; gap: 12px; padding-right: 26px; }
        .file-expiry-icon {
          flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
          background: #FDEBC8; color: #B7791F;
        }
        .file-expiry-today .file-expiry-icon { background: #FEE2E2; color: #DC2626; }
        .file-expiry-text { min-width: 0; }
        .file-expiry-title { margin: 0; font-size: 16px; font-weight: 800; line-height: 1.4; color: #2B2113; }
        .file-expiry-today .file-expiry-title { color: #991B1B; }
        .file-expiry-desc { margin: 3px 0 0; font-size: 13.5px; line-height: 1.6; color: #6B5A3E; }
        .file-expiry-cta {
          margin-top: 13px; width: 100%; height: 44px; border-radius: 12px;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          background: #D42020; color: #fff; font-size: 15px; font-weight: 700; text-decoration: none;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .file-expiry-cta:hover { background: #AE1717; transform: translateY(-1px); }
        .file-expiry-cta:focus-visible, .file-expiry-close:focus-visible { outline: 2px solid #D42020; outline-offset: 2px; }
        .file-expiry-close {
          position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; border: 0; border-radius: 999px;
          display: grid; place-items: center; background: rgba(59, 47, 30, 0.08); color: #6B5A3E; cursor: pointer;
        }
        .file-expiry-close:hover { background: rgba(59, 47, 30, 0.16); }
        @keyframes fileExpiryIn {
          from { opacity: 0; transform: translateY(-14px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) { .file-expiry { animation: none; } }
      `}</style>
    </div>
  );
}
