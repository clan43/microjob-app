"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Print Media template preview.
 *
 * An SVG shown through <img> cannot use the page's web fonts, so Bangla text silently falls back to a wider system
 * font (names get clipped, text leaves its badge) while the editor - which draws the SVG inline - looks perfect.
 * This component fetches the SVG, embeds the exact font files it needs, and shows the result, so the preview matches
 * the editor. PNG templates are shown as normal images.
 */

const FONT_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Anek+Bangla:wght@400;500;600;700;800&family=Baloo+Da+2:wght@400;500;600;700;800&family=Hind+Siliguri:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&family=Noto+Sans+Bengali:wght@400;500;600;700;800&family=Noto+Serif+Bengali:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tiro+Bangla&display=swap";
const SVG_NS = "http://www.w3.org/2000/svg";

type FontFaceRule = { family: string; weightMin: number; weightMax: number; ranges: Array<[number, number]>; url: string };

let fontRulesPromise: Promise<FontFaceRule[]> | null = null;
const fontDataCache = new Map<string, Promise<string>>();
const previewCache = new Map<string, Promise<string>>();
// Finished previews, readable synchronously: a card that scrolls back into view (or re-mounts after a filter change)
// shows its image instantly instead of flashing blank again.
const readyUrls = new Map<string, string>();

function parseUnicodeRange(value: string): Array<[number, number]> {
  if (!value) return [[0, 0x10ffff]];
  return value.split(",").map((part) => {
    const match = part.trim().match(/^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!match) return [0, 0] as [number, number];
    if (match[1].includes("?")) {
      return [parseInt(match[1].replace(/\?/g, "0"), 16), parseInt(match[1].replace(/\?/g, "F"), 16)] as [number, number];
    }
    const start = parseInt(match[1], 16);
    return [start, match[2] ? parseInt(match[2], 16) : start] as [number, number];
  });
}

function loadFontRules(): Promise<FontFaceRule[]> {
  if (!fontRulesPromise) {
    fontRulesPromise = (async () => {
      const css = await (await fetch(FONT_CSS_URL)).text();
      const rules: FontFaceRule[] = [];
      for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
        const family = block.match(/font-family:\s*['"]?([^;'"]+)['"]?\s*;/)?.[1]?.trim();
        const weight = block.match(/font-weight:\s*(\d+)(?:\s+(\d+))?/);
        const url = block.match(/url\(([^)]+)\)/)?.[1]?.replace(/['"]/g, "");
        const range = block.match(/unicode-range:\s*([^;]+);/)?.[1] ?? "";
        if (!family || !url) continue;
        const min = weight ? Number(weight[1]) : 400;
        rules.push({ family, weightMin: min, weightMax: weight?.[2] ? Number(weight[2]) : min, ranges: parseUnicodeRange(range), url });
      }
      return rules;
    })().catch((error) => {
      fontRulesPromise = null;
      throw error;
    });
  }
  return fontRulesPromise;
}

function fontToDataUri(url: string): Promise<string> {
  let cached = fontDataCache.get(url);
  if (!cached) {
    cached = (async () => {
      const blob = await (await fetch(url)).blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    })();
    fontDataCache.set(url, cached);
    cached.catch(() => fontDataCache.delete(url));
  }
  return cached;
}

async function embedFontsIntoSvg(markup: string): Promise<string> {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.localName !== "svg") return markup;

  const families = new Set<string>();
  const weights = new Set<number>([400]);
  const codePoints = new Set<number>();
  const addFamilies = (value: string | null) => {
    (value || "").split(",").forEach((item) => {
      const name = item.replace(/['"]|&quot;/g, "").trim();
      if (name) families.add(name.toLowerCase());
    });
  };
  addFamilies(root.getAttribute("font-family"));
  root.querySelectorAll("*").forEach((element) => {
    addFamilies(element.getAttribute("font-family"));
    const style = element.getAttribute("style") || "";
    const styleFamily = style.match(/font-family:\s*([^;]+)/)?.[1];
    if (styleFamily) addFamilies(styleFamily);
    const weight = element.getAttribute("font-weight") || style.match(/font-weight:\s*([^;]+)/)?.[1];
    if (weight) {
      const numeric = /bold/i.test(weight) ? 700 : Number(weight);
      if (Number.isFinite(numeric) && numeric > 0) weights.add(numeric);
    }
  });
  root.querySelectorAll("text").forEach((element) => {
    for (const char of element.textContent || "") codePoints.add(char.codePointAt(0) || 0);
  });
  if (codePoints.size === 0) return markup;
  // Joiners are needed to shape Bangla conjuncts, whichever subset the letters themselves come from.
  codePoints.add(0x200c);
  codePoints.add(0x200d);

  const rules = await loadFontRules();
  const wanted = rules.filter(
    (rule) =>
      families.has(rule.family.toLowerCase()) &&
      Array.from(weights).some((weight) => weight >= rule.weightMin && weight <= rule.weightMax) &&
      rule.ranges.some(([start, end]) => Array.from(codePoints).some((point) => point >= start && point <= end)),
  );
  if (wanted.length === 0) return markup;

  const faces = await Promise.all(
    wanted.map(async (rule) => {
      const data = await fontToDataUri(rule.url);
      const range = rule.ranges
        .map(([start, end]) => (start === end ? `U+${start.toString(16)}` : `U+${start.toString(16)}-${end.toString(16)}`))
        .join(",");
      return `@font-face{font-family:"${rule.family}";font-style:normal;font-weight:${rule.weightMin} ${rule.weightMax};src:url(${data}) format("woff2");unicode-range:${range};}`;
    }),
  );
  const style = doc.createElementNS(SVG_NS, "style");
  style.textContent = faces.join("\n");
  root.insertBefore(style, root.firstChild);
  return new XMLSerializer().serializeToString(root);
}

// Same auto-fit the editor uses: every template text remembers its original width (data-pm-maxw) and font size
// (data-pm-fs). If the text is wider than that, shrink it just enough to stay inside its badge / bar.
const AUTOFIT_MIN_SCALE = 0.4;

async function fitTextsToWidth(markup: string): Promise<string> {
  if (typeof document === "undefined") return markup;
  let host: HTMLDivElement | null = null;
  try {
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") return markup;
    const targets = Array.from(doc.querySelectorAll("text"));
    if (!targets.some((target) => target.hasAttribute("data-pm-maxw"))) return markup;

    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;width:2400px;height:2400px;visibility:hidden;pointer-events:none;overflow:hidden;";
    host.innerHTML = `<style>svg text,svg tspan{text-rendering:geometricPrecision;font-kerning:normal;font-variant-ligatures:normal;}</style>${markup}`;
    document.body.appendChild(host);

    // Wait until the embedded fonts are really in use, otherwise the measurement would use a fallback font.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const lives = Array.from(host.querySelectorAll("text")) as unknown as SVGTextElement[];
    let changed = false;
    lives.forEach((live, index) => {
      const target = targets[index];
      if (!target) return;
      if (!(live.textContent || "").trim()) return;
      const maxWidth = parseFloat(target.getAttribute("data-pm-maxw") || "");
      const baseSize = parseFloat(target.getAttribute("data-pm-fs") || "");
      if (!(maxWidth > 0) || !(baseSize > 0)) return;
      let size = baseSize;
      live.setAttribute("font-size", String(size));
      for (let pass = 0; pass < 3; pass += 1) {
        const width = live.getBBox().width;
        if (!(width > maxWidth * 1.003)) break;
        size = Math.max(baseSize * AUTOFIT_MIN_SCALE, size * (maxWidth / width));
        live.setAttribute("font-size", String(size));
      }
      size = Math.round(size * 100) / 100;
      if (target.getAttribute("font-size") !== String(size)) {
        target.setAttribute("font-size", String(size));
        const inline = target.getAttribute("style") || "";
        if (/font-size\s*:/.test(inline)) target.setAttribute("style", inline.replace(/font-size\s*:\s*[^;]+/, `font-size:${size}px`));
        changed = true;
      }
    });
    return changed ? new XMLSerializer().serializeToString(doc.documentElement) : markup;
  } catch {
    return markup;
  } finally {
    host?.remove();
  }
}

function buildPreviewUrl(src: string): Promise<string> {
  let cached = previewCache.get(src);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`Preview could not be loaded: ${src}`);
      const markup = await fitTextsToWidth(await embedFontsIntoSvg(await response.text()));
      const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
      readyUrls.set(src, url);
      return url;
    })();
    previewCache.set(src, cached);
    cached.catch(() => previewCache.delete(src));
  }
  return cached;
}

// ---- Build queue -----------------------------------------------------------------------------------------------
// Building a preview (download SVG + fonts, embed, measure text) is heavy. Doing 20-30 of them at once made the
// whole page slow and left many cards blank. So: only a few run at the same time, and whenever a slot frees up the
// card that is closest to what the user is looking at goes first. Cards the user scrolled past are dropped from the
// queue before they start.
const MAX_CONCURRENT_BUILDS = 3;

type BuildJob = {
  src: string;
  element: HTMLElement;
  cancelled: boolean;
  onReady: (url: string) => void;
  onFail: () => void;
};

let activeBuilds = 0;
const waitingJobs: BuildJob[] = [];

function distanceFromViewport(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const height = typeof window === "undefined" ? 800 : window.innerHeight;
  if (rect.bottom < 0) return -rect.bottom + 1000; // above the screen: lowest priority
  if (rect.top > height) return rect.top - height + 1; // just below the screen: next in line
  return rect.top / 1000; // on screen: top-most first
}

function pumpBuilds() {
  while (activeBuilds < MAX_CONCURRENT_BUILDS && waitingJobs.length > 0) {
    let bestIndex = 0;
    let bestScore = Infinity;
    for (let index = 0; index < waitingJobs.length; index += 1) {
      const score = distanceFromViewport(waitingJobs[index].element);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const job = waitingJobs.splice(bestIndex, 1)[0];
    activeBuilds += 1;
    buildPreviewUrl(job.src)
      .then((url) => {
        if (!job.cancelled) job.onReady(url);
      })
      .catch(() => {
        if (!job.cancelled) job.onFail();
      })
      .finally(() => {
        activeBuilds -= 1;
        pumpBuilds();
      });
  }
}

function queuePreview(src: string, element: HTMLElement, onReady: (url: string) => void, onFail: () => void): () => void {
  const job: BuildJob = { src, element, cancelled: false, onReady, onFail };
  waitingJobs.push(job);
  pumpBuilds();
  return () => {
    job.cancelled = true;
    const index = waitingJobs.indexOf(job);
    if (index >= 0) waitingJobs.splice(index, 1); // not started yet -> never wasted
  };
}

type SvgPreviewImageProps = {
  src: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
  /** Build right now, skipping the scroll check and the queue (use for the big popup preview). */
  priority?: boolean;
};

const BLANK_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export default function SvgPreviewImage({ src, alt, className, loading, priority = false }: SvgPreviewImageProps) {
  const isSvg = /\.svg(\?|#|$)/i.test(src);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState<{ source: string; url: string } | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [nearScreen, setNearScreen] = useState(false);

  const readyUrl = isSvg ? (ready?.source === src ? ready.url : readyUrls.get(src) ?? null) : null;
  const alreadyReady = readyUrl !== null;

  // Track whether this card is near the screen (130+ templates, so only the visible ones are built).
  // The observer keeps running: if the user scrolls past a card before its turn comes, its work is cancelled.
  useEffect(() => {
    if (!isSvg || alreadyReady || priority) return;
    const element = imageRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearScreen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setNearScreen(last.isIntersecting);
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isSvg, alreadyReady, priority, src]);

  useEffect(() => {
    if (!isSvg || alreadyReady) return;
    const element = imageRef.current;
    if (!element) return;
    if (priority) {
      let cancelled = false;
      buildPreviewUrl(src)
        .then((url) => {
          if (!cancelled) setReady({ source: src, url });
        })
        .catch(() => {
          if (!cancelled) setFailedSource(src);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!nearScreen) return;
    return queuePreview(
      src,
      element,
      (url) => setReady({ source: src, url }),
      () => setFailedSource(src),
    );
  }, [isSvg, alreadyReady, priority, nearScreen, src]);

  if (!isSvg) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} loading={loading} decoding="async" className={className} />;
  }

  const showOriginal = failedSource === src;
  const visible = alreadyReady || showOriginal;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imageRef}
      src={readyUrl ?? (showOriginal ? src : BLANK_GIF)}
      alt={alt}
      decoding="async"
      className={className}
      style={{ opacity: visible ? 1 : 0, transition: "opacity 160ms ease-out" }}
    />
  );
}
