"use client";

import { T } from "@/components/i18n/I18nProvider";
import DashboardNavbar from "@/app/dashboard/_components/DashboardNavbar";
import { getClientSession } from "@/lib/clientAuth";
import { notifyMyFilesSaved } from "@/app/_lib/myFilesNotice";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  FileImage,
  FileText,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Redo2,
  Save,
  SlidersHorizontal,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { PRINT_MEDIA_TEMPLATES, type PrintMediaTemplate } from "./templateCatalog";

type Manifest = {
  id: string;
  title: string;
  category: string;
  aspectRatio: string;
  physicalWidth: number;
  physicalHeight: number;
  unit: string;
  physicalSizeLabel?: string;
  viewBox: string;
  editableObjects?: Array<Record<string, unknown>>;
  printSettings?: { bleedMm?: number; safeMarginMm?: number; [key: string]: unknown };
};

function getCanvasDimensions(value: Manifest | null) {
  if (!value) return { width: 210, height: 297 };
  const viewBoxValues = value.viewBox.trim().split(/[\s,]+/).map(Number);
  const width = Number.isFinite(viewBoxValues[2]) && viewBoxValues[2] > 0 ? viewBoxValues[2] : value.physicalWidth;
  const height = Number.isFinite(viewBoxValues[3]) && viewBoxValues[3] > 0 ? viewBoxValues[3] : value.physicalHeight;
  return { width, height };
}

function toMillimeters(value: number, unit: string | undefined): number {
  const normalizedUnit = (unit || "mm").toLowerCase();
  if (["mm", "millimeter", "millimeters"].includes(normalizedUnit)) return value;
  if (["cm", "centimeter", "centimeters"].includes(normalizedUnit)) return value * 10;
  if (["in", "inch", "inches"].includes(normalizedUnit)) return value * 25.4;
  if (["ft", "foot", "feet"].includes(normalizedUnit)) return value * 304.8;
  if (normalizedUnit === "px") return value * 25.4 / 96;
  return value;
}

function calculateFitZoom(value: Manifest | null): number {
  if (!value || typeof window === "undefined") return 100;
  const dimensions = getCanvasDimensions(value);
  const baseWidth = 760;
  const portraitHeightAtFull = baseWidth * (dimensions.height / dimensions.width);
  const isWideViewport = window.innerWidth >= 1280;
  const availableWidth = Math.max(320, Math.min(baseWidth, window.innerWidth - (isWideViewport ? 660 : 40)));
  const availableHeight = Math.max(420, window.innerHeight - 350);
  const widthScale = (availableWidth / baseWidth) * 100;
  const heightScale = (availableHeight / portraitHeightAtFull) * 100;
  return Math.max(35, Math.min(100, Math.floor(Math.min(widthScale, heightScale))));
}

type LayerInfo = {
  id: string;
  name: string;
  tag: string;
  text: string;
  fill: string;
  stroke: string;
  fontSize: string;
  fontFamily: string;
  fontWeight: string;
  x: string;
  y: string;
  width: string;
  height: string;
  editable: boolean;
  objectType: string;
  cx: string;
  cy: string;
  radius: string;
  rx: string;
  opacity: string;
  strokeWidth: string;
};

const STORAGE_PREFIX = "sebalagbe-print-media-design-v1-";
const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const BENGALI_RE = /[\u0980-\u09FF]/;
const BENGALI_FONT_RE = /bengali|bangla|siliguri|baloo|tiro|nirmala|kalpurush|solaiman|lohit/i;
const BENGALI_FALLBACK_FONTS = '"Hind Siliguri", "Noto Sans Bengali", "Nirmala UI", sans-serif';

// Bangla keyboards (Avro, Bijoy, phonetic IME, mobile keyboards) can produce visually identical
// text from different Unicode sequences. Canonical NFC + removing stray control characters keeps
// conjuncts, vowel signs (ো, ৌ) and nukta letters (ড়, ঢ়, য়) shaping identically everywhere.
function cleanBanglaText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF\u200E\u200F\u202A-\u202E]/g, "")
    .normalize("NFC");
}

function readTextValue(element: Element): string {
  const lines = Array.from(element.children).filter((child) => child.localName === "tspan" && child.getAttribute("data-line") === "true");
  if (lines.length > 0) return lines.map((line) => line.textContent || "").join("\n");
  return element.textContent || "";
}

function roundMm(value: number): number {
  return Math.round(value * 100) / 100;
}

const NON_RENDER_TAGS = new Set(["defs", "clippath", "mask", "pattern", "marker", "symbol", "lineargradient", "radialgradient", "filter", "style", "title", "desc", "metadata", "script", "stop"]);
const SHAPE_TAGS = new Set(["text", "rect", "circle", "ellipse", "path", "line", "polygon", "polyline", "image", "use"]);

function isInsideNonRender(element: Element, root: Element): boolean {
  let node: Element | null = element.parentElement;
  while (node && node !== root) {
    if (NON_RENDER_TAGS.has(node.localName.toLowerCase())) return true;
    node = node.parentElement;
  }
  return false;
}

// Every drawable element of every template becomes selectable/movable/recolourable,
// not just the ones the template author tagged as editable.
function makeAllEditable(markup: string): string {
  const doc = parseSvg(markup);
  const root = doc.documentElement;
  const all = Array.from(root.querySelectorAll("*"));
  const eligible = (element: Element) => {
    const tag = element.localName.toLowerCase();
    if (element.getAttribute("data-editable") === "false") return false;
    if (element.getAttribute("data-editable") !== "true" && !SHAPE_TAGS.has(tag)) return false;
    if (isInsideNonRender(element, root)) return false;
    if (element.getAttribute("data-print") === "false" || element.closest('[data-print="false"]')) return false;
    const id = element.getAttribute("id") || "";
    if (id === "safe-area-guide" || id === "print_guides" || element.closest("#safe-area-guide, #print_guides")) return false;
    return true;
  };
  const targets = all.filter(eligible);
  const claimed = new Set<string>();
  all.forEach((element) => {
    const id = element.getAttribute("id");
    if (id && !targets.includes(element)) claimed.add(id);
  });
  let counter = 0;
  let layerNo = 0;
  targets.forEach((element) => {
    const tag = element.localName.toLowerCase();
    let id = element.getAttribute("id") || "";
    if (!id || claimed.has(id)) {
      do {
        counter += 1;
        id = `pm-auto-${counter}`;
      } while (claimed.has(id) || all.some((other) => other.getAttribute("id") === id));
      element.setAttribute("id", id);
    }
    claimed.add(id);
    element.setAttribute("data-editable", "true");
    if (!element.getAttribute("data-layer-name")) {
      layerNo += 1;
      const label = tag === "text" ? (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24) : "";
      element.setAttribute("data-layer-name", label || `${tag.charAt(0).toUpperCase()}${tag.slice(1)} ${layerNo}`);
    }
  });
  return serializeSvg(doc);
}

// ---- Drag-to-resize helpers (corner handles on images, frames and shapes) ----
type ResizeShape = { element: Element; attrs: Record<string, number> };

const RESIZE_ATTRS: Record<string, string[]> = {
  image: ["x", "y", "width", "height"],
  rect: ["x", "y", "width", "height", "rx"],
  circle: ["cx", "cy", "r"],
};

function readShape(element: Element | null): ResizeShape | null {
  if (!element) return null;
  const names = RESIZE_ATTRS[element.localName.toLowerCase()];
  if (!names) return null;
  const attrs: Record<string, number> = {};
  for (const name of names) {
    const raw = element.getAttribute(name);
    const value = raw === null || raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value)) return null;
    attrs[name] = value;
  }
  return { element, attrs };
}

function shapeBox(shape: ResizeShape): { x: number; y: number; w: number; h: number } {
  const a = shape.attrs;
  if (shape.element.localName.toLowerCase() === "circle") return { x: a.cx - a.r, y: a.cy - a.r, w: a.r * 2, h: a.r * 2 };
  return { x: a.x, y: a.y, w: a.width, h: a.height };
}

// Scales a shape around the anchor point (ax, ay): the opposite corner stays where it is.
function applyScale(shape: ResizeShape, ax: number, ay: number, scale: number) {
  const a = shape.attrs;
  const el = shape.element;
  const round = (n: number) => String(Math.round(n * 100) / 100);
  if (el.localName.toLowerCase() === "circle") {
    el.setAttribute("cx", round(ax + (a.cx - ax) * scale));
    el.setAttribute("cy", round(ay + (a.cy - ay) * scale));
    el.setAttribute("r", round(a.r * scale));
    return;
  }
  el.setAttribute("x", round(ax + (a.x - ax) * scale));
  el.setAttribute("y", round(ay + (a.y - ay) * scale));
  el.setAttribute("width", round(a.width * scale));
  el.setAttribute("height", round(a.height * scale));
  if (el.localName.toLowerCase() === "rect" && el.hasAttribute("rx")) el.setAttribute("rx", round(a.rx * scale));
}

// An uploaded photo is cut by a clip shape; it has to be scaled together with the photo.
function findClipShape(root: ParentNode, element: Element): Element | null {
  const match = /url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(element.getAttribute("clip-path") || "");
  if (!match) return null;
  const clip = Array.from(root.querySelectorAll("*")).find((node) => node.localName.toLowerCase() === "clippath" && node.getAttribute("id") === match[1]);
  return clip?.firstElementChild ?? null;
}

function getMove(element: Element): { dx: number; dy: number } {
  return { dx: parseFloat(element.getAttribute("data-dx") || "0") || 0, dy: parseFloat(element.getAttribute("data-dy") || "0") || 0 };
}

// Moving = a translate() placed in front of the element's original transform, so it works
// for paths, groups, text, images and shapes alike.
function setMove(element: Element, dx: number, dy: number) {
  if (!element.hasAttribute("data-orig-transform")) element.setAttribute("data-orig-transform", element.getAttribute("transform") || "");
  const original = element.getAttribute("data-orig-transform") || "";
  const r = (n: number) => Math.round(n * 100) / 100;
  element.setAttribute("data-dx", String(r(dx)));
  element.setAttribute("data-dy", String(r(dy)));
  const next = r(dx) === 0 && r(dy) === 0 ? original : `translate(${r(dx)} ${r(dy)}) ${original}`.trim();
  if (next) element.setAttribute("transform", next);
  else element.removeAttribute("transform");
}

function getPaint(element: Element, name: string): string {
  return ((element as SVGElement).style?.getPropertyValue(name) || "").trim() || element.getAttribute(name) || "";
}

function setPaintOn(element: Element, name: string, value: string) {
  element.setAttribute(name, value);
  (element as SVGElement).style?.setProperty(name, value);
}

function applyPaint(element: Element, name: string, value: string) {
  setPaintOn(element, name, value);
  if (name === "opacity") return;
  element.querySelectorAll("*").forEach((child) => {
    if (NON_RENDER_TAGS.has(child.localName.toLowerCase())) return;
    const current = getPaint(child, name);
    if (!current || current === "none") return;
    setPaintOn(child, name, value);
  });
}

function colorToHex(value: string): string | null {
  const v = (value || "").trim();
  if (!v || ["none", "transparent", "inherit", "currentcolor"].includes(v.toLowerCase()) || v.startsWith("url(")) return null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
  const toHex = (text: string) => {
    const m = text.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    return m ? `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}` : null;
  };
  const direct = toHex(v);
  if (direct) return direct;
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.fillStyle = "#010203";
  context.fillStyle = v;
  const out = String(context.fillStyle);
  if (out === "#010203") return null;
  return /^#[0-9a-f]{6}$/i.test(out) ? out : toHex(out);
}

// Number box that lets the person type freely (e.g. "-", "12.") and only commits valid numbers.
function NumberField({ value, onCommit, className }: { value: string; onCommit: (value: string) => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      className={className}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const next = event.target.value;
        setDraft(next);
        if (next.trim() !== "" && Number.isFinite(Number(next))) onCommit(next);
      }}
    />
  );
}

function parseSvg(markup: string): Document {
  if (typeof DOMParser === "undefined") throw new Error("SVG editing is only available in the browser.");
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") {
    throw new Error("The template SVG could not be read.");
  }
  return doc;
}

function serializeSvg(doc: Document): string {
  return new XMLSerializer().serializeToString(doc.documentElement);
}

function findSvgElement(doc: Document, id: string): Element | null {
  return Array.from(doc.documentElement.querySelectorAll("[id]")).find((element) => element.getAttribute("id") === id) ?? null;
}


const EXPORT_FONT_CSS_URL = "https://fonts.googleapis.com/css2?family=Anek+Bangla:wght@400;500;600;700;800&family=Baloo+Da+2:wght@400;500;600;700;800&family=Hind+Siliguri:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&family=Noto+Sans+Bengali:wght@400;500;600;700;800&family=Noto+Serif+Bengali:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tiro+Bangla&display=swap";

type FontFaceRule = { family: string; weightMin: number; weightMax: number; ranges: Array<[number, number]>; url: string };
let fontRulesPromise: Promise<FontFaceRule[]> | null = null;
const fontDataCache = new Map<string, Promise<string>>();

function parseUnicodeRange(value: string): Array<[number, number]> {
  if (!value) return [[0, 0x10ffff]];
  return value.split(",").map((part) => {
    const match = part.trim().match(/^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!match) return [0, 0] as [number, number];
    if (match[1].includes("?")) return [parseInt(match[1].replace(/\?/g, "0"), 16), parseInt(match[1].replace(/\?/g, "F"), 16)] as [number, number];
    const start = parseInt(match[1], 16);
    return [start, match[2] ? parseInt(match[2], 16) : start] as [number, number];
  });
}

function loadFontRules(): Promise<FontFaceRule[]> {
  if (!fontRulesPromise) {
    fontRulesPromise = (async () => {
      const css = await (await fetch(EXPORT_FONT_CSS_URL)).text();
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
    })().catch((fontError) => {
      fontRulesPromise = null;
      throw fontError;
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

// An SVG drawn through <img>/canvas cannot see the page's web fonts, so Bangla text silently falls back to a
// wider system font (names get clipped, text leaves its badge). Embedding the exact font files that the design
// uses makes PNG / PDF identical to what the editor shows.
async function embedFontsIntoSvg(markup: string): Promise<string> {
  try {
    const doc = parseSvg(markup);
    const root = doc.documentElement;
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
      const styleFamily = (element.getAttribute("style") || "").match(/font-family:\s*([^;]+)/)?.[1];
      if (styleFamily) addFamilies(styleFamily);
      const weight = element.getAttribute("font-weight") || (element.getAttribute("style") || "").match(/font-weight:\s*([^;]+)/)?.[1];
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
        const range = rule.ranges.map(([start, end]) => (start === end ? `U+${start.toString(16)}` : `U+${start.toString(16)}-${end.toString(16)}`)).join(",");
        return `@font-face{font-family:"${rule.family}";font-style:normal;font-weight:${rule.weightMin} ${rule.weightMax};src:url(${data}) format("woff2");unicode-range:${range};}`;
      }),
    );
    const style = doc.createElementNS(SVG_NS, "style");
    style.textContent = faces.join("\n");
    root.insertBefore(style, root.firstChild);
    return serializeSvg(doc);
  } catch (fontError) {
    console.warn("Could not embed fonts into the export; using the browser fonts instead.", fontError);
    return markup;
  }
}

// Outlined text (white/yellow text with a dark edge): draw the outline underneath the letters with round joins.
// Without this, letters whose glyph contours overlap show inner outline lines and the edge looks doubled/heavy.
function applyTextStrokeDefaults(doc: Document) {
  doc.querySelectorAll("text").forEach((element) => {
    const stroke = element.getAttribute("stroke") || (element.getAttribute("style") || "").match(/(?:^|;)\s*stroke:\s*([^;]+)/)?.[1] || "";
    if (!stroke || stroke.trim() === "none") return;
    const style = element.getAttribute("style") || "";
    if (!element.hasAttribute("paint-order") && !/paint-order/.test(style)) element.setAttribute("paint-order", "stroke fill");
    if (!element.hasAttribute("stroke-linejoin") && !/stroke-linejoin/.test(style)) element.setAttribute("stroke-linejoin", "round");
    if (!element.hasAttribute("stroke-linecap") && !/stroke-linecap/.test(style)) element.setAttribute("stroke-linecap", "round");
  });
}


// ---- Auto-fit text -------------------------------------------------------------------------------------------
// Every template text remembers how wide it was in the original design (data-pm-maxw) and its original font size
// (data-pm-fs). When someone types a longer name the font size shrinks just enough to keep the text inside its
// original width, so it never runs out of its bar / badge / circle. Short text goes back to the original size.
const AUTOFIT_MIN_SCALE = 0.4;

function measureHost(markup: string): { host: HTMLDivElement; texts: SVGTextElement[] } | null {
  if (typeof document === "undefined") return null;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:2400px;height:2400px;visibility:hidden;pointer-events:none;overflow:hidden;";
  host.innerHTML = `<style>svg text,svg tspan{text-rendering:geometricPrecision;font-kerning:normal;font-variant-ligatures:normal;}</style>${markup}`;
  document.body.appendChild(host);
  return { host, texts: Array.from(host.querySelectorAll("text")) as unknown as SVGTextElement[] };
}

function setLiveFontSize(element: SVGTextElement, size: number) {
  element.setAttribute("font-size", String(size));
  if (element.style && element.style.fontSize) element.style.fontSize = `${size}px`;
}

// mode "init": record the original width + size of every text that has none yet.
// mode "fit": shrink (or restore) the font size of texts that have a recorded width. onlyId limits it to one element.
function autoFitText(markup: string, mode: "init" | "fit", onlyId?: string): string {
  let measured: ReturnType<typeof measureHost> = null;
  try {
    measured = measureHost(markup);
    if (!measured) return markup;
    const doc = parseSvg(markup);
    const targets = Array.from(doc.querySelectorAll("text"));
    let changed = false;
    measured.texts.forEach((live, index) => {
      const target = targets[index];
      if (!target) return;
      if (onlyId && live.getAttribute("id") !== onlyId) return;
      if (!(live.textContent || "").trim()) return;
      if (mode === "init") {
        if (target.hasAttribute("data-pm-maxw")) return;
        const width = live.getBBox().width;
        const size = parseFloat(window.getComputedStyle(live).fontSize) || 0;
        if (!(width > 0) || !(size > 0)) return;
        target.setAttribute("data-pm-maxw", width.toFixed(2));
        target.setAttribute("data-pm-fs", String(size));
        changed = true;
        return;
      }
      const maxWidth = parseFloat(target.getAttribute("data-pm-maxw") || "");
      const baseSize = parseFloat(target.getAttribute("data-pm-fs") || "");
      if (!(maxWidth > 0) || !(baseSize > 0)) return;
      let size = baseSize;
      setLiveFontSize(live, size);
      for (let pass = 0; pass < 3; pass += 1) {
        const width = live.getBBox().width;
        if (!(width > maxWidth * 1.003)) break;
        size = Math.max(baseSize * AUTOFIT_MIN_SCALE, size * (maxWidth / width));
        setLiveFontSize(live, size);
      }
      size = Math.round(size * 100) / 100;
      if (target.getAttribute("font-size") !== String(size)) {
        target.setAttribute("font-size", String(size));
        const inline = target.getAttribute("style") || "";
        if (/font-size\s*:/.test(inline)) target.setAttribute("style", inline.replace(/font-size\s*:\s*[^;]+/, `font-size:${size}px`));
        changed = true;
      }
    });
    return changed ? serializeSvg(doc) : markup;
  } catch (fitError) {
    console.warn("Auto-fit text skipped.", fitError);
    return markup;
  } finally {
    measured?.host.remove();
  }
}


// The editor page must load the SAME web fonts that PNG / PDF export embeds. (A CSS @import placed after another
// rule is ignored by browsers, so the fonts are added with a real <link> instead.) Without this the preview
// silently used a fallback font and looked narrower than the download.
let editorFontsPromise: Promise<void> | null = null;
function ensureEditorFonts(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (!editorFontsPromise) {
    editorFontsPromise = new Promise<void>((resolve) => {
      const existing = document.getElementById("pm-editor-fonts") as HTMLLinkElement | null;
      if (existing?.sheet) {
        resolve();
        return;
      }
      const link = existing ?? document.createElement("link");
      if (!existing) {
        link.id = "pm-editor-fonts";
        link.rel = "stylesheet";
        link.href = EXPORT_FONT_CSS_URL;
      }
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener("error", () => resolve(), { once: true });
      if (!existing) document.head.appendChild(link);
      window.setTimeout(resolve, 6000);
    });
  }
  return editorFontsPromise;
}

async function waitForTemplateFonts(markup: string) {
  try {
    await ensureEditorFonts();
    if (typeof document === "undefined" || !document.fonts) return;
    const doc = parseSvg(markup);
    const jobs = new Map<string, { family: string; weight: string; sample: string }>();
    doc.querySelectorAll("text").forEach((element) => {
      const sample = (element.textContent || "").trim();
      if (!sample) return;
      const family = element.closest("[font-family]")?.getAttribute("font-family") || "sans-serif";
      const weight = element.closest("[font-weight]")?.getAttribute("font-weight") || "400";
      const key = `${weight}|${family}`;
      jobs.set(key, { family, weight, sample: `${jobs.get(key)?.sample ?? ""}${sample}`.slice(0, 2000) });
    });
    await Promise.race([
      Promise.all(Array.from(jobs.values()).map((job) => document.fonts.load(`${job.weight} 32px ${job.family}`, job.sample).catch(() => []))).then(() => document.fonts.ready),
      new Promise((resolve) => window.setTimeout(resolve, 5000)),
    ]);
  } catch {
    // best effort
  }
}


// The empty photo frame is only a guide (grey fill + dashed border). Once a photo sits in it the guide must disappear,
// otherwise a dashed box shows around the photo on screen and in the PNG / PDF. The original look is remembered so
// the frame comes back if the photo is deleted.
function hideFrameGuide(frame: Element) {
  if (!frame.hasAttribute("data-pm-orig-guide")) {
    frame.setAttribute(
      "data-pm-orig-guide",
      JSON.stringify({ fill: frame.getAttribute("fill"), stroke: frame.getAttribute("stroke"), dash: frame.getAttribute("stroke-dasharray"), width: frame.getAttribute("stroke-width"), style: frame.getAttribute("style") }),
    );
  }
  frame.setAttribute("fill", "none");
  frame.setAttribute("stroke", "none");
  frame.removeAttribute("stroke-dasharray");
  const style = frame.getAttribute("style");
  if (style) {
    const cleaned = style.replace(/(?:^|;)\s*(?:fill|stroke|stroke-dasharray|stroke-width)\s*:[^;]*/g, "").replace(/^;/, "");
    if (cleaned.trim()) frame.setAttribute("style", cleaned);
    else frame.removeAttribute("style");
  }
}

function restoreFrameGuide(frame: Element) {
  const raw = frame.getAttribute("data-pm-orig-guide");
  if (!raw) return;
  try {
    const original = JSON.parse(raw) as Record<string, string | null>;
    const apply = (name: string, value: string | null | undefined) => {
      if (value === null || value === undefined) frame.removeAttribute(name);
      else frame.setAttribute(name, value);
    };
    apply("fill", original.fill);
    apply("stroke", original.stroke);
    apply("stroke-dasharray", original.dash);
    apply("stroke-width", original.width);
    apply("style", original.style);
  } catch {
    // keep the frame as it is
  }
  frame.removeAttribute("data-pm-orig-guide");
}

// Designs saved before this fix (or a photo that sits right before its frame): hide the guide of every filled frame.
function hideGuidesOfFilledFrames(doc: Document) {
  doc.querySelectorAll('[data-object-type="image"]').forEach((frame) => {
    if (frame.localName === "image") return;
    const previous = frame.previousElementSibling;
    if (previous && previous.localName === "image" && (previous.getAttribute("data-layer-name") || "").startsWith("Uploaded image for")) {
      hideFrameGuide(frame);
    }
  });
}

function sanitizeSvg(markup: string): string {
  const doc = parseSvg(markup);
  doc.querySelectorAll("script, foreignObject, iframe, object, embed").forEach((node) => node.remove());
  Array.from(doc.documentElement.querySelectorAll("*")).forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name.endsWith(":href")) && value && !value.startsWith("data:image/") && !value.startsWith("#")) {
        element.removeAttribute(attribute.name);
      }
    });
  });
  return serializeSvg(doc);
}

function applyTypographyDefaults(markup: string): string {
  const doc = parseSvg(markup);
  const root = doc.documentElement;
  root.setAttribute("font-family", '\"Hind Siliguri\", \"Noto Sans Bengali\", \"Nirmala UI\", sans-serif');
  root.setAttribute("text-rendering", "geometricPrecision");
  root.setAttribute("font-kerning", "normal");
  root.setAttribute("lang", "bn");
  root.setAttributeNS(XML_NS, "xml:lang", "bn");

  const legacyDefaults = new Set([
    "Noto Sans Bengali, Hind Siliguri, sans-serif",
    "Noto Sans Bengali,Hind Siliguri,sans-serif",
    "'Noto Sans Bengali','Hind Siliguri','Noto Sans',sans-serif",
  ]);

  applyTextStrokeDefaults(doc);
  hideGuidesOfFilledFrames(doc);

  doc.querySelectorAll("text").forEach((element) => {
    const currentFamily = element.getAttribute("font-family")?.trim() || "";
    if (currentFamily && !legacyDefaults.has(currentFamily)) return;

    const content = element.textContent || "";
    if (!content.trim()) return;
    const hasBengali = /[\u0980-\u09FF]/.test(content);
    const weight = element.getAttribute("font-weight") || "400";
    const isBold = Number(weight) >= 700 || ["bold", "bolder"].includes(weight.toLowerCase());

    const family = hasBengali
      ? isBold
        ? '\"Anek Bangla\", \"Hind Siliguri\", \"Noto Sans Bengali\", sans-serif'
        : '\"Hind Siliguri\", \"Noto Sans Bengali\", \"Nirmala UI\", sans-serif'
      : '\"Plus Jakarta Sans\", \"Inter\", Arial, sans-serif';
    element.setAttribute("font-family", family);
  });

  return serializeSvg(doc);
}

function readLayers(markup: string): LayerInfo[] {
  if (!markup || typeof DOMParser === "undefined") return [];
  try {
    const doc = parseSvg(markup);
    return Array.from(doc.documentElement.querySelectorAll('[data-editable="true"]')).map((element, index) => {
      const tag = element.localName.toLowerCase();
      return {
        id: element.getAttribute("id") || `layer-${index + 1}`,
        name: element.getAttribute("data-layer-name") || element.getAttribute("id") || `Layer ${index + 1}`,
        tag,
        text: tag === "text" || tag === "tspan" ? readTextValue(element) : "",
        fill: getPaint(element, "fill"),
        stroke: getPaint(element, "stroke"),
        fontSize: element.getAttribute("font-size") || "",
        fontFamily: element.getAttribute("font-family") || "",
        fontWeight: element.getAttribute("font-weight") || "",
        x: (() => {
          const native = element.getAttribute("x") || element.getAttribute("cx") || element.getAttribute("x1") || "";
          const { dx } = getMove(element);
          if (!native) return String(dx);
          return Number.isFinite(Number(native)) ? String(Math.round((Number(native) + dx) * 100) / 100) : native;
        })(),
        y: (() => {
          const native = element.getAttribute("y") || element.getAttribute("cy") || element.getAttribute("y1") || "";
          const { dy } = getMove(element);
          if (!native) return String(dy);
          return Number.isFinite(Number(native)) ? String(Math.round((Number(native) + dy) * 100) / 100) : native;
        })(),
        width: element.getAttribute("width") || "",
        height: element.getAttribute("height") || "",
        editable: element.getAttribute("data-editable") === "true",
        objectType: element.getAttribute("data-object-type") || "shape",
        cx: element.getAttribute("cx") || "",
        cy: element.getAttribute("cy") || "",
        radius: element.getAttribute("r") || "",
        rx: element.getAttribute("rx") || "",
        opacity: getPaint(element, "opacity") || "1",
        strokeWidth: getPaint(element, "stroke-width"),
      };
    });
  } catch {
    return [];
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeFilename(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\-]+/g, "-").replace(/^-+|-+$/g, "") || "print-media-design";
}

export default function PrintMediaEditor({ templateId }: { templateId: number }) {
  const router = useRouter();
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [template, setTemplate] = useState<PrintMediaTemplate | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [svgMarkup, setSvgMarkup] = useState("");
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedLayer, setSelectedLayer] = useState<LayerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // The "My Files" entry of this design (set after the first cloud save / when opened from My Files),
  // so every next Save updates the same file instead of creating duplicates.
  const cloudFileIdRef = useRef("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showLayers, setShowLayers] = useState(true);
  const [showProperties, setShowProperties] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [textDraft, setTextDraft] = useState("");
  const composingRef = useRef(false);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const syncedLayerIdRef = useRef<string | null>(null);
  const printingRef = useRef(false);
  useEffect(() => {
    void ensureEditorFonts();
  }, []);
  const suppressClickRef = useRef(false);
  const nudgeRef = useRef<(dx: number, dy: number) => void>(() => {});
  const printWrapRef = useRef<HTMLDivElement>(null);
  const [selBox, setSelBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const findLiveElement = (id: string): SVGGraphicsElement | null => {
    const svg = svgContainerRef.current?.querySelector("svg");
    if (!svg || !id) return null;
    const found = Array.from(svg.querySelectorAll("[id]")).find((element) => element.getAttribute("id") === id);
    return (found as SVGGraphicsElement | undefined) ?? null;
  };

  // Places the four resize handles on the selected image / frame / shape.
  const updateSelBox = (idOverride?: string) => {
    const wrap = printWrapRef.current;
    const svg = svgContainerRef.current?.querySelector("svg");
    const element = findLiveElement(idOverride ?? selectedId);
    if (!wrap || !svg || !element || !RESIZE_ATTRS[element.localName.toLowerCase()]) {
      setSelBox(null);
      return;
    }
    try {
      const bbox = element.getBBox();
      const viewBox = svg.viewBox.baseVal;
      if (viewBox && viewBox.width > 0 && bbox.width >= viewBox.width * 0.9 && bbox.height >= viewBox.height * 0.9) {
        setSelBox(null); // the page background is not resized
        return;
      }
    } catch {
      setSelBox(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const base = wrap.getBoundingClientRect();
    setSelBox({ left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height });
  };

  const startResize = (corner: "nw" | "ne" | "sw" | "se") => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const id = selectedId;
    const svg = svgContainerRef.current?.querySelector("svg");
    const liveElement = findLiveElement(id);
    const matrix = svg?.getScreenCTM();
    if (!svg || !liveElement || !matrix || !matrix.a) return;
    const unitsPerPx = 1 / matrix.a;
    const primary = readShape(liveElement);
    if (!primary) return;
    const liveClip = readShape(findClipShape(svg, liveElement));
    const box = shapeBox(primary);
    if (box.w <= 0 || box.h <= 0) return;
    const east = corner.includes("e");
    const south = corner.includes("s");
    const ax = east ? box.x : box.x + box.w;
    const ay = south ? box.y : box.y + box.h;
    const startX = event.clientX;
    const startY = event.clientY;
    let scale = 1;

    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const dx = (moveEvent.clientX - startX) * unitsPerPx;
      const dy = (moveEvent.clientY - startY) * unitsPerPx;
      const sx = ((east ? 1 : -1) * dx + box.w) / box.w;
      const sy = ((south ? 1 : -1) * dy + box.h) / box.h;
      scale = Math.max(0.1, Math.max(sx, sy));
      applyScale(primary, ax, ay, scale);
      if (liveClip) applyScale(liveClip, ax, ay, scale);
      updateSelBox(id);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (Math.abs(scale - 1) < 0.001) return;
      try {
        const doc = parseSvg(svgMarkup);
        const docElement = findSvgElement(doc, id);
        const docPrimary = readShape(docElement);
        if (!docElement || !docPrimary) return;
        const docClip = readShape(findClipShape(doc, docElement));
        applyScale(docPrimary, ax, ay, scale);
        if (docClip) applyScale(docClip, ax, ay, scale);
        commitSvg(serializeSvg(doc));
      } catch {
        setError("Could not resize the element.");
      }
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const printDesignRef = useRef<() => Promise<void>>(async () => {});

  const templateFromCatalog = useMemo(
    () => PRINT_MEDIA_TEMPLATES.find((item) => item.id === templateId) ?? null,
    [templateId],
  );

  useEffect(() => {
    let mounted = true;
    void getClientSession().then((session) => {
      if (mounted && !session.authenticated) {
        router.replace(`/login?callbackUrl=${encodeURIComponent(`/print-media/editor/${templateId}`)}`);
      }
    });
    return () => {
      mounted = false;
    };
  }, [router, templateId]);

  useEffect(() => {
    let active = true;
    async function loadTemplate() {
      setLoading(true);
      setError("");
      if (!templateFromCatalog) {
        setError("Template not found.");
        setLoading(false);
        return;
      }
      try {
        const [svgResponse, jsonResponse] = await Promise.all([
          fetch(templateFromCatalog.svgUrl),
          fetch(templateFromCatalog.jsonUrl),
        ]);
        if (!svgResponse.ok) throw new Error(`SVG file could not be loaded (${svgResponse.status}).`);
        if (!jsonResponse.ok) throw new Error(`Template information could not be loaded (${jsonResponse.status}).`);
        const [rawSvg, rawManifest] = await Promise.all([svgResponse.text(), jsonResponse.json() as Promise<Manifest>]);
        if (!active) return;
        const cleanSvg = makeAllEditable(applyTypographyDefaults(sanitizeSvg(rawSvg)));
        let initialSvg = cleanSvg;
        let loadedFromCloud = false;
        let loadNotice = "";
        cloudFileIdRef.current = "";

        // Opened from "My Files" (?file=user-file:...): continue the design that was saved there.
        const fileParam = new URLSearchParams(window.location.search).get("file") || "";
        if (fileParam) {
          try {
            const savedResponse = await fetch(`/api/my-files?id=${encodeURIComponent(fileParam)}`, {
              credentials: "include",
              cache: "no-store",
            });
            const savedResult = await savedResponse.json().catch(() => null);
            if (
              savedResponse.ok &&
              savedResult?.success &&
              typeof savedResult.data?.svgMarkup === "string" &&
              Number(savedResult.data.templateId) === templateId
            ) {
              initialSvg = makeAllEditable(applyTypographyDefaults(sanitizeSvg(savedResult.data.svgMarkup)));
              cloudFileIdRef.current = String(savedResult.data.id || fileParam);
              loadedFromCloud = true;
            } else {
              loadNotice = "সেভ করা ডিজাইনটি পাওয়া যায়নি (হয়তো মুছে গেছে)। টেমপ্লেটটি নতুন করে খোলা হয়েছে।";
            }
          } catch {
            loadNotice = "সেভ করা ডিজাইনটি লোড করা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।";
          }
          if (!active) return;
        }

        if (!loadedFromCloud) {
          try {
            const savedDesign = window.localStorage.getItem(`${STORAGE_PREFIX}${templateId}`);
            if (savedDesign) {
              const savedData = JSON.parse(savedDesign) as { svgMarkup?: string; cloudFileId?: string };
              if (savedData.svgMarkup) initialSvg = makeAllEditable(applyTypographyDefaults(sanitizeSvg(savedData.svgMarkup)));
              if (savedData.cloudFileId) cloudFileIdRef.current = savedData.cloudFileId;
            }
          } catch {
            // Continue with the original template if local storage is unavailable.
          }
        }
        setTemplate(templateFromCatalog);
        setManifest(rawManifest);
        setZoom(calculateFitZoom(rawManifest));
        await waitForTemplateFonts(initialSvg);
        initialSvg = autoFitText(initialSvg, "init");
        // Templates can ship their own box widths (data-pm-maxw): make sure the starting text already fits them.
        initialSvg = autoFitText(initialSvg, "fit");
        if (!active) return;
        setSvgMarkup(initialSvg);
        setHistory([initialSvg]);
        setHistoryIndex(0);
        setSaved(false);
        if (loadNotice) setError(loadNotice);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to open this template.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadTemplate();
    return () => {
      active = false;
    };
  }, [templateFromCatalog, templateId]);

  useEffect(() => {
    const nextLayers = readLayers(svgMarkup);
    setLayers(nextLayers);
    if (selectedId) {
      setSelectedLayer(nextLayers.find((layer) => layer.id === selectedId) ?? null);
    } else {
      setSelectedLayer(null);
    }
  }, [svgMarkup, selectedId]);

  // Keep the text box in sync when another layer is selected or undo/redo changes the text,
  // but never overwrite what the person is typing/composing (that was dropping Bangla characters).
  useEffect(() => {
    if (composingRef.current) return;
    const layerId = selectedLayer?.id ?? null;
    const layerChanged = syncedLayerIdRef.current !== layerId;
    syncedLayerIdRef.current = layerId;
    // While the person is typing in the box, never pull the text back from the SVG: Bangla keyboards
    // such as Avro send many quick key events, and a late sync would put an older value over the newer one
    // (that is what produced wrong/extra letters like "ডরবিউল" instead of "রবিউল").
    if (!layerChanged && textAreaRef.current && document.activeElement === textAreaRef.current) return;
    const next = selectedLayer?.text ?? "";
    setTextDraft((current) => (cleanBanglaText(current) === cleanBanglaText(next) ? current : next));
  }, [selectedLayer?.id, selectedLayer?.text]);

  useEffect(() => {
    const svg = svgContainerRef.current?.querySelector("svg");
    if (!svg) return;
    svg.querySelectorAll("[data-editor-selected='true']").forEach((element) => element.removeAttribute("data-editor-selected"));
    if (selectedId) {
      const selected = Array.from(svg.querySelectorAll("[id]")).find((element) => element.getAttribute("id") === selectedId);
      selected?.setAttribute("data-editor-selected", "true");
    }
  }, [selectedId, svgMarkup]);

  useEffect(() => {
    updateSelBox();
    const onWindowResize = () => updateSelBox();
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, svgMarkup, zoom]);

  useEffect(() => {
    const handleKeyboardShortcuts = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveDesign();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        // Browser Ctrl+P would print the whole editor UI (extra pages); use the exact-size print instead.
        event.preventDefault();
        void printDesignRef.current();
        return;
      }
      if (isTyping) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const step = event.shiftKey ? 5 : 1;
        nudgeRef.current(event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
        event.preventDefault();
        redo();
      } else if (event.key === "Escape") {
        setSelectedId("");
      }
    };
    window.addEventListener("keydown", handleKeyboardShortcuts);
    return () => window.removeEventListener("keydown", handleKeyboardShortcuts);
  }, [historyIndex, history, svgMarkup, template]);

  const commitSvg = (nextMarkup: string) => {
    setSvgMarkup(nextMarkup);
    const nextHistory = [...history.slice(0, historyIndex + 1), nextMarkup];
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
    setSaved(false);
  };

  const updateSelected = (attribute: string, value: string) => {
    if (!selectedId || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, selectedId);
      if (!element) return;
      if (attribute === "textContent") {
        const text = cleanBanglaText(value);
        const lines = text.split("\n");
        while (element.firstChild) element.removeChild(element.firstChild);
        if (element.localName === "text") {
          // Keep spaces exactly as typed instead of letting SVG collapse them.
          element.setAttributeNS(XML_NS, "xml:space", "preserve");
          element.setAttribute("lang", BENGALI_RE.test(text) ? "bn" : "en");
          if (lines.length > 1) {
            const x = element.getAttribute("x") || "0";
            lines.forEach((line, index) => {
              const tspan = element.ownerDocument.createElementNS(SVG_NS, "tspan");
              tspan.setAttribute("data-line", "true");
              tspan.setAttribute("x", x);
              if (index > 0) tspan.setAttribute("dy", "1.3em");
              tspan.textContent = line;
              element.appendChild(tspan);
            });
          } else {
            element.textContent = text;
          }
          // Typing Bangla into an English-only font would show broken fallback glyphs.
          const family = element.getAttribute("font-family") || "";
          if (BENGALI_RE.test(text) && family && !BENGALI_FONT_RE.test(family)) {
            element.setAttribute("font-family", `${family}, ${BENGALI_FALLBACK_FONTS}`);
          }
        } else {
          element.textContent = text.replace(/\n/g, " ");
        }
      } else if (attribute === "fill" || attribute === "stroke" || attribute === "opacity" || attribute === "stroke-width") {
        applyPaint(element, attribute, value);
      } else {
        if (attribute === "font-size") {
          // The person chose a size on purpose: stop auto-fitting this text.
          element.removeAttribute("data-pm-maxw");
          element.removeAttribute("data-pm-fs");
          const inline = element.getAttribute("style") || "";
          if (/font-size\s*:/.test(inline)) element.setAttribute("style", inline.replace(/font-size\s*:\s*[^;]+/, `font-size:${value}px`));
        }
        element.setAttribute(attribute, value);
      }
      let nextMarkup = serializeSvg(doc);
      if (attribute === "textContent" || attribute === "font-family" || attribute === "font-weight") {
        nextMarkup = autoFitText(nextMarkup, "fit", selectedId);
      }
      commitSvg(nextMarkup);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update this element.");
    }
  };

  const updateCoordinate = (axis: "x" | "y", value: string) => {
    if (!selectedId || !svgMarkup) return;
    try {
      const num = Number(value);
      if (value.trim() === "" || !Number.isFinite(num)) return;
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, selectedId);
      if (!element) return;
      const candidates = axis === "x" ? ["x", "cx", "x1"] : ["y", "cy", "y1"];
      const attribute = candidates.find((name) => element.hasAttribute(name));
      const move = getMove(element);
      if (!attribute) {
        // Paths, polygons, groups… have no x/y, so the box moves them directly.
        if (axis === "x") setMove(element, num, move.dy);
        else setMove(element, move.dx, num);
      } else {
        element.setAttribute(attribute, String(num - (axis === "x" ? move.dx : move.dy)));
      }
      commitSvg(serializeSvg(doc));
    } catch {
      setError("Could not update the element position.");
    }
  };

  // Layer order (what sits in front of what): one step, or all the way to the front / back.
  const reorderSelected = (mode: "forward" | "backward" | "front" | "back") => {
    if (!selectedId || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, selectedId);
      const parent = element?.parentNode;
      if (!element || !parent) return;
      const isArtwork = (node: Element) => !["defs", "style", "title", "desc", "metadata", "clippath"].includes(node.localName.toLowerCase());
      const artwork = Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1 && isArtwork(node as Element));
      const index = artwork.indexOf(element);
      if (index < 0) return;
      const liveOf = (node: Element) => {
        const id = node.getAttribute("id");
        return id ? findLiveElement(id) : null;
      };
      const liveSelf = liveOf(element);
      // One step jumps over the layers that do not touch this one, so every click visibly changes something.
      const touches = (other: Element) => {
        const a = liveSelf?.getBoundingClientRect();
        const b = liveOf(other)?.getBoundingClientRect();
        if (!a || !b) return true;
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      };
      if (mode === "front") {
        if (index === artwork.length - 1) return;
        parent.appendChild(element);
      } else if (mode === "back") {
        if (index === 0) return;
        parent.insertBefore(element, artwork[0]);
      } else if (mode === "forward") {
        if (index === artwork.length - 1) return;
        let target = artwork[artwork.length - 1];
        for (let i = index + 1; i < artwork.length; i += 1) {
          if (touches(artwork[i])) { target = artwork[i]; break; }
        }
        parent.insertBefore(element, target.nextSibling);
      } else {
        if (index === 0) return;
        let target = artwork[0];
        for (let i = index - 1; i >= 0; i -= 1) {
          if (touches(artwork[i])) { target = artwork[i]; break; }
        }
        parent.insertBefore(element, target);
      }
      commitSvg(serializeSvg(doc));
    } catch {
      setError("Could not change the layer order.");
    }
  };

  const moveSelectedBy = (deltaX: number, deltaY: number) => {
    if (!selectedId || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, selectedId);
      if (!element) return;
      const move = getMove(element);
      setMove(element, move.dx + deltaX, move.dy + deltaY);
      commitSvg(serializeSvg(doc));
    } catch {
      setError("Could not move the element.");
    }
  };
  nudgeRef.current = moveSelectedBy;

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target;
    const container = svgContainerRef.current;
    if (!(target instanceof Element) || !container) return;
    const editable = target.closest('[data-editable="true"]') as SVGGraphicsElement | null;
    if (!editable || !container.contains(editable)) return;
    const id = editable.getAttribute("id") || "";
    if (!id) return;
    setSelectedId(id);

    // The big page background is selectable (colour change) but is not dragged around.
    const svg = container.querySelector("svg");
    try {
      const box = editable.getBBox();
      const viewBox = svg?.viewBox.baseVal;
      if (viewBox && viewBox.width > 0 && box.width >= viewBox.width * 0.9 && box.height >= viewBox.height * 0.9) return;
    } catch {
      // getBBox can fail for hidden elements; dragging is simply skipped.
    }
    const parent = editable.parentNode as SVGGraphicsElement | null;
    const matrix = parent?.getScreenCTM?.();
    if (!matrix) return;
    // Older SVGMatrix has no transformPoint(), so apply the inverse matrix by hand.
    const inverse = matrix.inverse();
    const toLocal = (clientX: number, clientY: number) => ({
      x: inverse.a * clientX + inverse.c * clientY + inverse.e,
      y: inverse.b * clientX + inverse.d * clientY + inverse.f,
    });
    const start = toLocal(event.clientX, event.clientY);
    const base = getMove(editable);
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let moved = false;
    let finalDx = base.dx;
    let finalDy = base.dy;

    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startClientX, moveEvent.clientY - startClientY) < 3) return;
      moved = true;
      moveEvent.preventDefault();
      const point = toLocal(moveEvent.clientX, moveEvent.clientY);
      finalDx = base.dx + (point.x - start.x);
      finalDy = base.dy + (point.y - start.y);
      setMove(editable, finalDx, finalDy);
      updateSelBox(id);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved) return;
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      try {
        const doc = parseSvg(svgMarkup);
        const element = findSvgElement(doc, id);
        if (!element) return;
        setMove(element, finalDx, finalDy);
        commitSvg(serializeSvg(doc));
      } catch {
        setError("Could not move the element.");
      }
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handleSvgClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) return;
    const target = event.target;
    if (!(target instanceof Element)) {
      setSelectedId("");
      return;
    }
    const editable = target.closest('[data-editable="true"]');
    if (!editable || !svgContainerRef.current?.contains(editable)) {
      // Clicking an empty part of the artwork clears the current selection.
      setSelectedId("");
      return;
    }
    const id = editable.getAttribute("id");
    setSelectedId(id || "");
  };

  const handleEditorPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectedId) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Keep the selection while the user edits properties, chooses layers or presses toolbar actions.
    if (
      target.closest("[data-pm-keep-selection='true']") ||
      target.closest("button, input, textarea, select, label, [contenteditable='true']")
    ) return;
    // Canvas clicks are handled by handleSvgClick so clicking blank canvas deselects cleanly.
    if (svgContainerRef.current?.contains(target)) return;
    // Any other click outside the artwork releases the active object.
    setSelectedId("");
  };

  const addText = () => {
    if (!svgMarkup || !manifest) return;
    try {
      const doc = parseSvg(svgMarkup);
      const text = doc.createElementNS(SVG_NS, "text");
      const id = `user-text-${Date.now()}`;
      text.setAttribute("id", id);
      text.setAttribute("data-layer-name", "নতুন লেখা");
      text.setAttribute("data-editable", "true");
      const canvas = getCanvasDimensions(manifest);
      text.setAttribute("x", String(Math.round(canvas.width / 2)));
      text.setAttribute("y", String(Math.round(canvas.height / 2)));
      text.setAttribute("font-family", '"Hind Siliguri", "Noto Sans Bengali", "Nirmala UI", sans-serif');
      text.setAttribute("font-size", "32");
      text.setAttribute("font-weight", "600");
      text.setAttribute("fill", "#222222");
      text.setAttribute("text-anchor", "middle");
      text.textContent = "আপনার লেখা";
      doc.documentElement.appendChild(text);
      commitSvg(serializeSvg(doc));
      setSelectedId(id);
    } catch {
      setError("Could not add a text layer.");
    }
  };

  const addImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedId || !svgMarkup) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setError("Please use an image smaller than 12 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      try {
        const doc = parseSvg(svgMarkup);
        const frame = findSvgElement(doc, selectedId);
        if (!frame || frame.getAttribute("data-object-type") !== "image") {
          setError("Select an image placeholder before uploading a photo or logo.");
          return;
        }

        const isCircle = frame.localName.toLowerCase() === "circle";
        let x = 0;
        let y = 0;
        let width = 0;
        let height = 0;
        let clipShape: Element;

        if (isCircle) {
          const cx = Number(frame.getAttribute("cx") || 0);
          const cy = Number(frame.getAttribute("cy") || 0);
          const radius = Number(frame.getAttribute("r") || 0);
          if (!radius) throw new Error("This circular placeholder has no usable dimensions.");
          x = cx - radius;
          y = cy - radius;
          width = radius * 2;
          height = radius * 2;
          clipShape = doc.createElementNS(SVG_NS, "circle");
          clipShape.setAttribute("cx", String(cx));
          clipShape.setAttribute("cy", String(cy));
          clipShape.setAttribute("r", String(radius));
        } else {
          x = Number(frame.getAttribute("x") || 0);
          y = Number(frame.getAttribute("y") || 0);
          width = Number(frame.getAttribute("width") || 0);
          height = Number(frame.getAttribute("height") || 0);
          if (!width || !height) throw new Error("This image placeholder has no usable dimensions.");
          clipShape = doc.createElementNS(SVG_NS, "rect");
          clipShape.setAttribute("x", String(x));
          clipShape.setAttribute("y", String(y));
          clipShape.setAttribute("width", String(width));
          clipShape.setAttribute("height", String(height));
          clipShape.setAttribute("rx", frame.getAttribute("rx") || "0");
        }

        const clipId = `uploaded-photo-clip-${Date.now()}`;
        let defs = doc.documentElement.querySelector("defs");
        if (!defs) {
          defs = doc.createElementNS(SVG_NS, "defs");
          doc.documentElement.insertBefore(defs, doc.documentElement.firstChild);
        }
        const clipPath = doc.createElementNS(SVG_NS, "clipPath");
        clipPath.setAttribute("id", clipId);
        clipPath.setAttribute("clipPathUnits", "userSpaceOnUse");
        clipPath.appendChild(clipShape);
        defs.appendChild(clipPath);

        const image = doc.createElementNS(SVG_NS, "image");
        image.setAttribute("id", `uploaded-image-${Date.now()}`);
        image.setAttribute("data-layer-name", `Uploaded image for ${frame.getAttribute("data-layer-name") || selectedId}`);
        image.setAttribute("data-editable", "true");
        image.setAttribute("data-object-type", "image");
        image.setAttribute("href", reader.result);
        image.setAttribute("x", String(x));
        image.setAttribute("y", String(y));
        image.setAttribute("width", String(width));
        image.setAttribute("height", String(height));
        image.setAttribute("preserveAspectRatio", "xMidYMid slice");
        image.setAttribute("clip-path", `url(#${clipId})`);
        frame.parentNode?.insertBefore(image, frame);
        hideFrameGuide(frame);

        const hint = findSvgElement(doc, `${selectedId}_hint`);
        hint?.setAttribute("display", "none");
        if (selectedId === "qr_image_placeholder") {
          findSvgElement(doc, "qr_hint_text")?.setAttribute("display", "none");
        }

        commitSvg(serializeSvg(doc));
        setSelectedId(image.getAttribute("id") || "");
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "Could not place this image.");
      }
    };
    reader.onerror = () => setError("The selected image could not be read.");
    reader.readAsDataURL(file);
  };
  const deleteSelected = () => {
    if (!selectedId || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, selectedId);
      if (!element || element.id === "background") return;
      if (element.localName === "image" && (element.getAttribute("data-layer-name") || "").startsWith("Uploaded image for")) {
        const next = element.nextElementSibling;
        if (next && next.hasAttribute("data-pm-orig-guide")) {
          restoreFrameGuide(next);
          const hintId = `${next.getAttribute("id")}_hint`;
          findSvgElement(doc, hintId)?.removeAttribute("display");
        }
      }
      element.remove();
      commitSvg(serializeSvg(doc));
      setSelectedId("");
    } catch {
      setError("Could not remove this layer.");
    }
  };

  // Saves the design to "My Files" (preview image on Cloudinary + the editable SVG in the database).
  const saveToMyFiles = async (markup: string, currentTemplate: PrintMediaTemplate) => {
    const previewBlob = await renderPngBlob(300 / 25.4, 1000);
    // Send the PNG as a binary file (multipart) instead of a base64 string inside JSON.
    const uploadForm = new FormData();
    uploadForm.append("file", previewBlob, `print-preview-${Date.now()}.png`);
    const uploadResponse = await fetch("/api/upload", {
      method: "POST",
      credentials: "include",
      body: uploadForm,
    });
    const upload = await uploadResponse.json().catch(() => null);
    if (!uploadResponse.ok || !upload?.success || !upload?.url) {
      throw new Error(upload?.error || upload?.message || "preview upload failed");
    }
    const url = String(upload.url);
    const publicId = String(upload.publicId || "");
    const name = currentTemplate.title;

    let response: Response | null = null;
    if (cloudFileIdRef.current) {
      response = await fetch("/api/my-files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: cloudFileIdRef.current, name, url, publicId, svgMarkup: markup }),
      });
      if (response.status === 404) {
        // The earlier copy was deleted from My Files: save this one as a new file.
        cloudFileIdRef.current = "";
        response = null;
      }
    }
    if (!response) {
      response = await fetch("/api/my-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name,
          category: "print-media",
          toolName: "Print Media",
          workspace: "creative",
          group: "image",
          url,
          publicId,
          templateId: currentTemplate.id,
          svgMarkup: markup,
        }),
      });
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.success || !result?.data?.id) {
      throw new Error(result?.error || result?.message || "save failed");
    }
    cloudFileIdRef.current = String(result.data.id);
  };

  const writeLocalSave = (markup: string, currentTemplate: PrintMediaTemplate) => {
    try {
      window.localStorage.setItem(
        `${STORAGE_PREFIX}${currentTemplate.id}`,
        JSON.stringify({
          svgMarkup: markup,
          updatedAt: new Date().toISOString(),
          templateId: currentTemplate.id,
          cloudFileId: cloudFileIdRef.current || undefined,
        }),
      );
      return true;
    } catch {
      return false;
    }
  };

  const saveDesign = async () => {
    if (!svgMarkup || !template || !manifest || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const markup = svgMarkup;
    // Always keep a copy in this browser first, so nothing is lost even if the cloud save fails.
    const localOk = writeLocalSave(markup, template);
    try {
      await saveToMyFiles(markup, template);
      writeLocalSave(markup, template); // remember the My Files entry for the next Save
      setSaved(true);
      notifyMyFilesSaved(1, "design");
    } catch (saveError) {
      console.error("Failed to save Print Media design to My Files:", saveError);
      const reason = saveError instanceof Error ? saveError.message : "";
      setSaved(false);
      setError(
        `${localOk ? "ডিজাইনটি এই ব্রাউজারে সেভ হয়েছে, কিন্তু" : "ডিজাইনটি"} ‘আমার ফাইল’-এ সেভ করা যায়নি। ইন্টারনেট সংযোগ দেখে আবার Save চাপুন।${reason && !/failed|read failed/i.test(reason) ? ` (${reason})` : ""}`,
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const undo = () => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    setSvgMarkup(history[nextIndex]);
    setSaved(false);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    setSvgMarkup(history[nextIndex]);
    setSaved(false);
  };

  const cleanSvgForExport = () => {
    const doc = parseSvg(svgMarkup);
    const guide = findSvgElement(doc, "safe-area-guide");
    guide?.remove();
    findSvgElement(doc, "print_guides")?.remove();
    doc.querySelectorAll('[data-print="false"]').forEach((node) => node.remove());
    doc.querySelectorAll("[data-editor-selected]").forEach((node) => node.removeAttribute("data-editor-selected"));
    hideGuidesOfFilledFrames(doc);
    doc.documentElement.setAttribute("xmlns", SVG_NS);
    return serializeSvg(doc);
  };

  // Renders the current design to a PNG. Used for the PNG download and for the My Files preview.
  const renderPngBlob = async (targetPixelsPerMm: number, maxPixelEdge: number): Promise<Blob> => {
    if (!manifest) throw new Error("Template is not ready.");
    const exportMarkup = await embedFontsIntoSvg(cleanSvgForExport());
    const url = URL.createObjectURL(new Blob([exportMarkup], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const image = new Image();
      image.decoding = "sync";
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The SVG could not be rendered for PNG export."));
        image.src = url;
      });
      try {
        await image.decode();
      } catch {
        // decode() can reject for SVG images in some browsers; onload already fired so continue.
      }
      const dimensions = getCanvasDimensions(manifest);
      const scale = Math.min(targetPixelsPerMm, maxPixelEdge / Math.max(dimensions.width, dimensions.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(dimensions.width * scale));
      canvas.height = Math.max(1, Math.ceil(dimensions.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Your browser does not support PNG export.");
      // Embedded fonts inside an SVG image can finish a moment after onload: draw once to warm them up, then draw for real.
      context.drawImage(image, 0, 0, 8, 8);
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed."))), "image/png");
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const exportPng = async () => {
    if (!svgMarkup || !template || !manifest) return;
    try {
      const blob = await renderPngBlob(300 / 25.4, 12000);
      downloadBlob(blob, `${String(template.id).padStart(2, "0")}-${safeFilename(template.title)}.png`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "PNG export failed. Please try again.");
    }
  };

  const printDesign = async () => {
    if (!svgMarkup || !manifest || printingRef.current) return;
    printingRef.current = true;

    let frame: HTMLIFrameElement | null = null;
    let removeTimer = 0;
    try {
      document.querySelectorAll('iframe[data-pm-print-frame="true"]').forEach((node) => node.remove());

      // Round to 0.01mm so floating point noise (e.g. 304.79999mm) can never make the page one pixel too small.
      const physicalWidthMm = roundMm(toMillimeters(manifest.physicalWidth, manifest.unit));
      const physicalHeightMm = roundMm(toMillimeters(manifest.physicalHeight, manifest.unit));
      if (!Number.isFinite(physicalWidthMm) || !Number.isFinite(physicalHeightMm) || physicalWidthMm <= 0 || physicalHeightMm <= 0) {
        throw new Error("এই টেমপ্লেটের প্রিন্ট সাইজ সঠিক নয়। Template size settings পরীক্ষা করুন।");
      }

      // Print exactly what the PNG download shows: render once (fonts embedded) at 300 dpi and print that picture.
      // This removes every browser/font difference between the editor, the PNG and the printed PDF.
      const printBlob = await renderPngBlob(300 / 25.4, 12000);
      const printImageUrl = URL.createObjectURL(printBlob);

      frame = document.createElement("iframe");
      frame.setAttribute("title", "SebaLagbe print document");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("data-pm-print-frame", "true");
      frame.style.position = "fixed";
      frame.style.right = "0";
      frame.style.bottom = "0";
      frame.style.width = "1px";
      frame.style.height = "1px";
      frame.style.border = "0";
      frame.style.opacity = "0";
      frame.style.pointerEvents = "none";
      document.body.appendChild(frame);

      const printWindow = frame.contentWindow;
      const printDocument = printWindow?.document;
      if (!printWindow || !printDocument) throw new Error("Browser print window could not be prepared.");

      const pageW = `${physicalWidthMm}mm`;
      const pageH = `${physicalHeightMm}mm`;
      // The sheet is a hair (0.3mm) shorter than the paper and the SVG is absolutely positioned inside it.
      // An exact-height box is what normally spills one pixel onto a second blank page after rounding.
      printDocument.open();
      printDocument.write(`<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${(template?.title || "Print Design").replace(/[&<>\"]/g, "")}</title>
<style>
  @page { size: ${pageW} ${pageH}; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff; width: ${pageW}; overflow: hidden; }
  html { height: auto; }
  body { height: auto; }
  .pm-sheet { position: relative; display: block; width: ${pageW}; height: calc(${pageH} - 0.3mm); overflow: visible; break-inside: avoid; break-before: avoid; break-after: avoid; page-break-inside: avoid; page-break-before: avoid; page-break-after: avoid; }
  .pm-sheet > img { position: absolute; left: 0; top: 0; display: block; width: ${pageW} !important; height: ${pageH} !important; max-width: none !important; max-height: none !important; background: #fff; image-rendering: auto; }
  svg text, svg tspan { text-rendering: geometricPrecision; font-kerning: normal; font-variant-ligatures: normal; }
  @media screen { body { outline: 1px solid #ddd; } }
</style>
</head>
<body><div class="pm-sheet"><img id="pm-print-art" alt="" src="${printImageUrl}" /></div></body>
</html>`);
      printDocument.close();

      const cleanup = () => {
        window.clearTimeout(removeTimer);
        window.setTimeout(() => {
          frame?.remove();
          URL.revokeObjectURL(printImageUrl);
        }, 1200);
      };
      printWindow.addEventListener("afterprint", cleanup, { once: true });
      // Safety net: if the browser never fires afterprint, still remove the hidden frame.
      removeTimer = window.setTimeout(() => {
        frame?.remove();
        URL.revokeObjectURL(printImageUrl);
      }, 10 * 60 * 1000);

      // Wait until the picture is fully decoded before opening the print dialog.
      try {
        const art = printDocument.getElementById("pm-print-art") as HTMLImageElement | null;
        await Promise.race([art ? art.decode() : Promise.resolve(), new Promise((resolve) => window.setTimeout(resolve, 15000))]);
        await new Promise<void>((resolve) => printWindow.requestAnimationFrame(() => printWindow.requestAnimationFrame(() => resolve())));
      } catch {
        // Decoding is best-effort; printing continues.
      }

      await new Promise((resolve) => window.setTimeout(resolve, 250));
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        cleanup();
        setError("প্রিন্ট ডায়ালগ চালু করা যায়নি। আবার Print / PDF চাপুন।");
      }
    } catch (printError) {
      window.clearTimeout(removeTimer);
      frame?.remove();
      setError(printError instanceof Error ? printError.message : "Print / PDF তৈরি করা যায়নি।");
    } finally {
      printingRef.current = false;
    }
  };
  printDesignRef.current = printDesign;

  const panelColor = (prop: "fill" | "stroke") => {
    const direct = colorToHex(selectedLayer ? selectedLayer[prop] : "");
    if (direct) return direct;
    try {
      const live = selectedId ? Array.from<Element>(svgContainerRef.current?.querySelectorAll("[id]") ?? []).find((element: Element) => element.getAttribute("id") === selectedId) : null;
      if (live) {
        const computed = colorToHex(window.getComputedStyle(live)[prop]);
        if (computed) return computed;
      }
    } catch {
      // fall through to the default colour
    }
    return "#000000";
  };

  const canvasDimensions = getCanvasDimensions(manifest);
  const pagePrintWidthMm = manifest ? roundMm(toMillimeters(manifest.physicalWidth, manifest.unit)) : 210;
  const pagePrintHeightMm = manifest ? roundMm(toMillimeters(manifest.physicalHeight, manifest.unit)) : 297;
  const canvasStyle = manifest
    ? { aspectRatio: `${canvasDimensions.width} / ${canvasDimensions.height}` }
    : undefined;

  return (
    <div onPointerDownCapture={handleEditorPointerDown} className="min-h-screen flex flex-col bg-[#EDE3D0] text-[#332A1D] pm-editor-font">
      <DashboardNavbar />
      <style>{`
        @page { size: ${pagePrintWidthMm}mm ${pagePrintHeightMm}mm; margin: 0; }
        @import url('https://fonts.googleapis.com/css2?family=Anek+Bangla:wght@400;500;600;700;800&family=Baloo+Da+2:wght@400;500;600;700;800&family=Hind+Siliguri:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&family=Noto+Sans+Bengali:wght@400;500;600;700;800&family=Noto+Serif+Bengali:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tiro+Bangla&display=swap');
        .editor-action { display:inline-flex; align-items:center; justify-content:center; gap:7px; border:1px solid #e2d4b9; background:#fffaf0; color:#5b4a31; border-radius:11px; padding:9px 12px; font-size:12px; font-weight:700; transition:all .15s ease; }
        .editor-action:hover:not(:disabled) { border-color:#dc2626; color:#dc2626; background:#fff; }
        .editor-action:disabled { opacity:.4; cursor:not-allowed; }
        .editor-action-primary { display:inline-flex; align-items:center; justify-content:center; gap:7px; border:1px solid #dc2626; background:#dc2626; color:#fff; border-radius:11px; padding:9px 13px; font-size:12px; font-weight:800; transition:all .15s ease; }
        .editor-action-primary:hover { background:#b91c1c; }
        .editor-tool { display:inline-flex; align-items:center; justify-content:center; gap:6px; border:1px solid #e2d4b9; background:#fffaf0; color:#6a5332; border-radius:9px; padding:8px 5px; font-size:11px; font-weight:700; }
        .editor-tool:hover:not(:disabled) { border-color:#dc2626; color:#dc2626; }
        .editor-tool:disabled { opacity:.45; cursor:not-allowed; }
        .editor-zoom { width:28px; height:28px; border-radius:8px; border:1px solid #d7c7a7; background:#fffaf0; color:#6a5332; font-weight:800; }
        .pm-editor-font, .pm-editor-font *:not(svg):not(svg *) { font-family: "Plus Jakarta Sans", "Hind Siliguri", "Noto Sans Bengali", sans-serif; -webkit-font-smoothing: antialiased; }
        .pm-canvas svg { width: 100%; height: auto; max-height: 100%; display: block; }
        .pm-canvas svg text, .pm-canvas svg tspan { text-rendering: geometricPrecision; font-kerning: normal; font-variant-ligatures: normal; }
        .pm-canvas svg [data-editor-selected="true"]:not(#bg_page):not(#background):not([data-layer-name="Page Background"]) { filter: drop-shadow(0 0 1px rgba(220,38,38,.95)) drop-shadow(0 0 1px rgba(220,38,38,.65)); }
        .pm-canvas svg [data-editor-selected="true"]#bg_page, .pm-canvas svg [data-editor-selected="true"]#background { filter:none !important; }
        .pm-canvas svg [data-editable="true"] { cursor: move; touch-action: none; }
        .pm-resize-handle { position: absolute; width: 14px; height: 14px; background: #fff; border: 2px solid #dc2626; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,.35); touch-action: none; z-index: 30; }
        .pm-canvas svg [data-editable="true"]:hover:not([data-editor-selected="true"]) { opacity: .92; }
        .pm-property-input { width: 100%; border: 1px solid #ded1b7; border-radius: 10px; background: #fffaf0; color: #332a1d; padding: 9px 10px; outline: none; font-size: 13px; }
        .pm-property-input:focus { border-color: #dc2626; box-shadow: 0 0 0 3px rgba(220,38,38,.1); }
        @media print {
          /* Fallback if the browser menu is used instead of the Print / PDF button: print only the artwork, on one page. */
          html, body { background:#fff !important; margin:0 !important; padding:0 !important; height:0 !important; min-height:0 !important; overflow:hidden !important; }
          body * { visibility:hidden !important; }
          #pm-print-area, #pm-print-area * { visibility:visible !important; }
          #pm-print-area { position:fixed !important; left:0 !important; top:0 !important; width:${pagePrintWidthMm}mm !important; height:${pagePrintHeightMm}mm !important; aspect-ratio:auto !important; margin:0 !important; padding:0 !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; overflow:hidden !important; break-inside:avoid !important; }
          #pm-print-area svg { width:100% !important; height:100% !important; max-height:none !important; display:block !important; }
          #pm-print-area svg [data-editor-selected="true"] { filter:none !important; }
        }
      `}</style>

      <div data-pm-keep-selection="true" className="sticky top-16 z-40 px-3 sm:px-5 py-3 border-b border-[#D9C9A9] bg-[#F7F0E2]/95 backdrop-blur-md shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button type="button" onClick={() => router.push("/print-media")} className="w-10 h-10 rounded-xl border border-[#E2D4B9] bg-white text-[#5B4A31] hover:text-[#DC2626] hover:border-[#DC2626] flex items-center justify-center shrink-0" aria-label="Back to templates">
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-[#A06A32]"><T>Print Media Editor</T></div>
            <h1 className="font-extrabold text-[16px] sm:text-[19px] text-[#332A1D] truncate">{template?.title ?? <T>Loading template...</T>}</h1>
          </div>
        </div>
        <div className="flex items-center flex-wrap gap-2">
          <button type="button" onClick={undo} disabled={historyIndex <= 0} className="editor-action" aria-label="Undo"><Undo2 size={16} /><span className="hidden sm:inline"><T>Undo</T></span></button>
          <button type="button" onClick={redo} disabled={historyIndex < 0 || historyIndex >= history.length - 1} className="editor-action" aria-label="Redo"><Redo2 size={16} /><span className="hidden sm:inline"><T>Redo</T></span></button>
          <button type="button" onClick={() => void saveDesign()} disabled={saving} className="editor-action-primary disabled:cursor-wait disabled:opacity-70">{saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />}<T>Save</T></button>
          <button type="button" onClick={() => void exportPng()} className="editor-action"><FileImage size={16} /><span className="hidden sm:inline">PNG</span></button>
          <button type="button" onClick={() => void printDesign()} className="editor-action"><FileText size={16} /><span className="hidden sm:inline"><T>Print / PDF</T></span></button>
        </div>
      </div>

      <div className="flex-1 p-3 sm:p-4 lg:p-5">
        {error && (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button>
          </div>
        )}
        {saved && (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700">
            <Check size={16} /> <T>ডিজাইন ‘আমার ফাইল’-এ সেভ হয়েছে। সেখান থেকে যেকোনো সময় খুলে বাকি কাজ করতে পারবেন।</T>
          </div>
        )}

        {loading ? (
          <div className="min-h-[55vh] flex items-center justify-center text-[#806E50] gap-3">
            <LoaderCircle size={22} className="animate-spin" />
            <span className="font-semibold"><T>Loading editable template...</T></span>
          </div>
        ) : error && !svgMarkup ? (
          <div className="min-h-[50vh] flex flex-col items-center justify-center text-center gap-3">
            <p className="font-bold text-lg">{error}</p>
            <button type="button" onClick={() => router.push("/print-media")} className="px-4 py-2 rounded-xl bg-[#DC2626] text-white font-bold"><T>Back to templates</T></button>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-[250px_minmax(0,1fr)_290px] gap-4 items-start">
            <aside className="bg-[#F8F1E4] border border-[#E2D4B9] rounded-2xl shadow-sm overflow-hidden">
              <button type="button" onClick={() => setShowLayers((value) => !value)} className="w-full flex items-center justify-between px-4 py-3 border-b border-[#E2D4B9] font-bold text-sm">
                <span className="flex items-center gap-2"><Layers3 size={16} className="text-[#DC2626]" /><T>Layers</T> <span className="text-xs text-[#907B58]">({layers.length})</span></span>
                <ChevronDown size={15} className={`transition-transform ${showLayers ? "rotate-180" : ""}`} />
              </button>
              {showLayers && (
                <div className="p-2 max-h-[46vh] xl:max-h-[62vh] overflow-y-auto space-y-1">
                  {layers.map((layer) => (
                    <button
                      type="button"
                      key={layer.id}
                      onClick={() => setSelectedId(layer.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-[12px] truncate transition ${selectedId === layer.id ? "bg-[#F7DDB8] text-[#C2410C] font-bold" : "text-[#5C4B32] hover:bg-[#EEE2CC]"}`}
                      title={layer.name}
                    >
                      <span className="inline-block w-5 text-[10px] uppercase opacity-50">{layer.tag.slice(0, 3)}</span>
                      {layer.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="p-3 border-t border-[#E2D4B9] grid grid-cols-2 gap-2">
                <button type="button" onClick={addText} className="editor-tool"><Type size={15} /><T>Add text</T></button>
                <button type="button" onClick={() => imageInputRef.current?.click()} disabled={!selectedLayer || !selectedLayer.width || !selectedLayer.height} className="editor-tool"><ImagePlus size={15} /><T>Add image</T></button>
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={addImage} />
              </div>
              <p className="px-3 pb-3 text-[10px] leading-4 text-[#907B58]"><T>ক্যানভাসে কোনো অবজেক্টে ক্লিক করুন অথবা লেয়ার তালিকা থেকে নির্বাচন করুন।</T></p>
            </aside>

            <main className="min-w-0 space-y-3">
              <div className="flex items-center justify-between gap-3 px-1">
                <div className="text-[12px] font-semibold text-[#806E50] truncate">
                  {manifest?.physicalSizeLabel || template?.printSize} · {manifest?.physicalWidth ?? canvasDimensions.width} × {manifest?.physicalHeight ?? canvasDimensions.height} {manifest?.unit || "mm"}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button type="button" onClick={() => setZoom((value) => Math.max(35, value - 10))} className="editor-zoom">−</button>
                  <span className="text-xs font-bold text-[#705D3D] w-10 text-center">{zoom}%</span>
                  <button type="button" onClick={() => setZoom((value) => Math.min(200, value + 10))} className="editor-zoom">+</button>
                  <button type="button" onClick={() => setZoom(calculateFitZoom(manifest))} className="text-xs font-semibold text-[#A04B2A] px-1"><T>Fit</T></button>
                </div>
              </div>
              <div className="bg-[#D9D0C1] border border-[#CFC2A9] rounded-2xl p-3 sm:p-5 lg:p-7 min-h-[55vh] flex items-center justify-center overflow-auto">
                <div ref={printWrapRef} className="relative" style={{ flexShrink: 0 }}>
                  <div
                    id="pm-print-area"
                    ref={svgContainerRef}
                    onClick={handleSvgClick}
                    onPointerDown={handleCanvasPointerDown}
                    className="pm-canvas bg-white shadow-[0_12px_40px_rgba(52,40,20,.18)] ring-1 ring-black/10"
                    style={{ ...canvasStyle, width: `${Math.round(760 * zoom / 100)}px`, flexShrink: 0 }}
                    dangerouslySetInnerHTML={{ __html: svgMarkup }}
                  />
                  {selBox && (["nw", "ne", "sw", "se"] as const).map((corner) => (
                    <div
                      key={corner}
                      data-pm-keep-selection="true"
                      onPointerDown={startResize(corner)}
                      className="pm-resize-handle"
                      title="Drag to resize"
                      style={{
                        left: selBox.left + (corner.includes("e") ? selBox.width : 0) - 7,
                        top: selBox.top + (corner.includes("s") ? selBox.height : 0) - 7,
                        cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                      }}
                    />
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-[#8B7656] px-1"><T>ক্যানভাসের ফাঁকা জায়গা বা বাইরে ক্লিক করলে নির্বাচিত অবজেক্টের selection উঠে যাবে। Print / PDF আলাদা print page খুলে সঠিক মাপে প্রিন্ট করবে।</T></p>
            </main>

            <aside className="bg-[#F8F1E4] border border-[#E2D4B9] rounded-2xl shadow-sm overflow-hidden flex flex-col xl:sticky xl:top-[136px] xl:max-h-[calc(100vh-148px)]">
              <button type="button" onClick={() => setShowProperties((value) => !value)} className="w-full flex items-center justify-between px-4 py-3 border-b border-[#E2D4B9] font-bold text-sm">
                <span className="inline-flex items-center"><SlidersHorizontal size={16} className="mr-2 text-[#DC2626]" /><T>Properties</T></span>
                <ChevronDown size={15} className={`transition-transform ${showProperties ? "rotate-180" : ""}`} />
              </button>
              {showProperties && (
                <div className="p-4 space-y-4 min-h-0 overflow-y-auto flex-1">
                  {selectedLayer ? (
                    <>
                      <div>
                        <p className="text-[11px] font-bold text-[#9A835D] uppercase tracking-wide mb-1"><T>Selected layer</T></p>
                        <p className="text-sm font-bold text-[#3B2F1E] break-words">{selectedLayer.name}</p>
                        <p className="text-[10px] text-[#917C59] mt-1">{selectedLayer.objectType.toUpperCase()} · {selectedLayer.id}</p>
                      </div>
                      <div>
                        <p className="text-xs font-bold text-[#6F5B3C] mb-1.5"><T>Layer order</T></p>
                        <div className="grid grid-cols-2 gap-2">
                          <button type="button" onClick={() => reorderSelected("forward")} className="rounded-xl border border-[#E2D4B9] bg-white px-2 py-2 text-[12px] font-bold text-[#5C4B32] hover:bg-[#F7DDB8]">↑ <T>সামনে আনুন</T></button>
                          <button type="button" onClick={() => reorderSelected("backward")} className="rounded-xl border border-[#E2D4B9] bg-white px-2 py-2 text-[12px] font-bold text-[#5C4B32] hover:bg-[#F7DDB8]">↓ <T>পেছনে পাঠান</T></button>
                          <button type="button" onClick={() => reorderSelected("front")} className="rounded-xl border border-[#E2D4B9] bg-white px-2 py-2 text-[12px] font-bold text-[#5C4B32] hover:bg-[#F7DDB8]">⤒ <T>একদম সামনে</T></button>
                          <button type="button" onClick={() => reorderSelected("back")} className="rounded-xl border border-[#E2D4B9] bg-white px-2 py-2 text-[12px] font-bold text-[#5C4B32] hover:bg-[#F7DDB8]">⤓ <T>একদম পেছনে</T></button>
                        </div>
                      </div>
                      {selectedLayer.tag === "text" || selectedLayer.tag === "tspan" ? (
                        <label className="block space-y-1.5">
                          <span className="text-xs font-bold text-[#6F5B3C]"><T>Text content</T></span>
                          <textarea
                            ref={textAreaRef}
                            value={textDraft}
                            lang="bn"
                            spellCheck={false}
                            autoCorrect="off"
                            autoCapitalize="off"
                            onCompositionStart={() => { composingRef.current = true; }}
                            onCompositionEnd={(event) => {
                              composingRef.current = false;
                              const value = event.currentTarget.value;
                              setTextDraft(value);
                              updateSelected("textContent", value);
                            }}
                            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                              const value = event.target.value;
                              setTextDraft(value);
                              // While an IME/Bangla keyboard is still composing, wait; commit when it finishes.
                              if (!composingRef.current) updateSelected("textContent", value);
                            }}
                            rows={3}
                            className="pm-property-input resize-y"
                            style={{ fontFamily: '"Hind Siliguri", "Noto Sans Bengali", "Nirmala UI", sans-serif', lineHeight: 1.5 }}
                          />
                        </label>
                      ) : null}
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1.5">
                          <span className="text-xs font-bold text-[#6F5B3C]">X</span>
                          <NumberField value={selectedLayer.x} onCommit={(value) => updateCoordinate("x", value)} className="pm-property-input" />
                        </label>
                        <label className="block space-y-1.5">
                          <span className="text-xs font-bold text-[#6F5B3C]">Y</span>
                          <NumberField value={selectedLayer.y} onCommit={(value) => updateCoordinate("y", value)} className="pm-property-input" />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1.5">
                          <span className="text-xs font-bold text-[#6F5B3C]"><T>Fill color</T></span>
                          <input type="color" value={panelColor("fill")} onChange={(event: ChangeEvent<HTMLInputElement>) => updateSelected("fill", event.target.value)} className="w-full h-10 rounded-lg border border-[#DED1B7] bg-white p-1" />
                        </label>
                        <label className="block space-y-1.5">
                          <span className="text-xs font-bold text-[#6F5B3C]"><T>Stroke color</T></span>
                          <input type="color" value={panelColor("stroke")} onChange={(event: ChangeEvent<HTMLInputElement>) => updateSelected("stroke", event.target.value)} className="w-full h-10 rounded-lg border border-[#DED1B7] bg-white p-1" />
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => updateSelected("fill", "none")} className="flex-1 rounded-lg border border-[#DED1B7] bg-white py-1.5 text-[11px] font-bold text-[#6F5B3C] hover:border-[#DC2626] hover:text-[#DC2626]"><T>No fill</T></button>
                        <button type="button" onClick={() => updateSelected("stroke", "none")} className="flex-1 rounded-lg border border-[#DED1B7] bg-white py-1.5 text-[11px] font-bold text-[#6F5B3C] hover:border-[#DC2626] hover:text-[#DC2626]"><T>No stroke</T></button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1.5">
                          <span className="text-xs font-bold text-[#6F5B3C]"><T>Opacity</T> · {Math.round((parseFloat(selectedLayer.opacity) || 0) * 100)}%</span>
                          <input type="range" min="0" max="100" step="5" value={Math.round((Number.isFinite(parseFloat(selectedLayer.opacity)) ? parseFloat(selectedLayer.opacity) : 1) * 100)} onChange={(event: ChangeEvent<HTMLInputElement>) => updateSelected("opacity", String(Number(event.target.value) / 100))} className="w-full accent-[#DC2626]" />
                        </label>
                        {selectedLayer.tag !== "text" && selectedLayer.tag !== "tspan" && selectedLayer.tag !== "image" ? (
                          <label className="block space-y-1.5">
                            <span className="text-xs font-bold text-[#6F5B3C]"><T>Stroke width</T></span>
                            <NumberField value={selectedLayer.strokeWidth || "0"} onCommit={(value) => updateSelected("stroke-width", value)} className="pm-property-input" />
                          </label>
                        ) : null}
                      </div>
                      {(selectedLayer.tag === "text" || selectedLayer.tag === "tspan") && (
                        <>
                          <label className="block space-y-1.5">
                            <span className="text-xs font-bold text-[#6F5B3C]"><T>Font size</T></span>
                            <input type="number" min="6" max="300" value={selectedLayer.fontSize || "24"} onChange={(event: ChangeEvent<HTMLInputElement>) => updateSelected("font-size", event.target.value)} className="pm-property-input" />
                          </label>
                          <label className="block space-y-1.5">
                            <span className="text-xs font-bold text-[#6F5B3C]"><T>Font family</T></span>
                            <select value={selectedLayer.fontFamily || '\"Hind Siliguri\", \"Noto Sans Bengali\", \"Nirmala UI\", sans-serif'} onChange={(event: ChangeEvent<HTMLSelectElement>) => updateSelected("font-family", event.target.value)} className="pm-property-input">
                              <optgroup label="বাংলা ফন্ট">
                                <option value={'\"Hind Siliguri\", \"Noto Sans Bengali\", \"Nirmala UI\", sans-serif'}>Hind Siliguri — পরিষ্কার ও আধুনিক</option>
                                <option value={'\"Anek Bangla\", \"Hind Siliguri\", \"Noto Sans Bengali\", sans-serif'}>Anek Bangla — আধুনিক শিরোনাম</option>
                                <option value={'\"Noto Sans Bengali\", \"Hind Siliguri\", sans-serif'}>Noto Sans Bengali — স্ট্যান্ডার্ড</option>
                                <option value={'\"Baloo Da 2\", \"Hind Siliguri\", sans-serif'}>Baloo Da 2 — গোলাকার স্টাইল</option>
                                <option value={'\"Noto Serif Bengali\", \"Tiro Bangla\", serif'}>Noto Serif Bengali — ক্লাসিক</option>
                                <option value={'\"Tiro Bangla\", \"Noto Serif Bengali\", serif'}>Tiro Bangla — ঐতিহ্যবাহী</option>
                              </optgroup>
                              <optgroup label="English fonts">
                                <option value={'\"Plus Jakarta Sans\", \"Inter\", sans-serif'}>Plus Jakarta Sans</option>
                                <option value={'\"Inter\", Arial, sans-serif'}>Inter</option>
                                <option value="Arial, sans-serif">Arial</option>
                              </optgroup>
                            </select>
                          </label>
                          <label className="block space-y-1.5">
                            <span className="text-xs font-bold text-[#6F5B3C]"><T>Font weight</T></span>
                            <select value={selectedLayer.fontWeight || "600"} onChange={(event: ChangeEvent<HTMLSelectElement>) => updateSelected("font-weight", event.target.value)} className="pm-property-input">
                              <option value="400">Regular</option>
                              <option value="500">Medium</option>
                              <option value="600">Semi Bold</option>
                              <option value="700">Bold</option>
                              <option value="800">Extra Bold</option>
                            </select>
                          </label>
                        </>
                      )}
                      {(selectedLayer.width || selectedLayer.height) && (
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block space-y-1.5">
                            <span className="text-xs font-bold text-[#6F5B3C]"><T>Width</T></span>
                            <input type="number" min="1" value={selectedLayer.width} onChange={(event: ChangeEvent<HTMLInputElement>) => updateSelected("width", event.target.value)} className="pm-property-input" />
                          </label>
                          <label className="block space-y-1.5">
                            <span className="text-xs font-bold text-[#6F5B3C]"><T>Height</T></span>
                            <input type="number" min="1" value={selectedLayer.height} onChange={(event: ChangeEvent<HTMLInputElement>) => updateSelected("height", event.target.value)} className="pm-property-input" />
                          </label>
                        </div>
                      )}
                      {selectedLayer.objectType === "image" && (
                        <button type="button" onClick={() => imageInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 rounded-xl border border-[#D9C7A5] bg-white py-2.5 text-xs font-bold text-[#785B32] hover:border-[#DC2626] hover:text-[#DC2626]">
                          <Upload size={15} /> <T>Place photo in this frame</T>
                        </button>
                      )}
                      <button type="button" onClick={deleteSelected} className="w-full flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 py-2.5 text-xs font-bold text-red-600 hover:bg-red-100">
                        <Trash2 size={15} /> <T>Delete selected layer</T>
                      </button>
                    </>
                  ) : (
                    <div className="py-8 text-center">
                      <Layers3 size={26} className="mx-auto text-[#B19B75] mb-2" />
                      <p className="text-sm font-bold text-[#5D4B31]"><T>Select an element</T></p>
                      <p className="text-xs leading-5 text-[#927D5B] mt-1"><T>ক্যানভাস অথবা Layers থেকে কোনো লেখা, শেপ বা ছবি নির্বাচন করুন।</T></p>
                    </div>
                  )}
                  <div className="border-t border-[#E2D4B9] pt-3 text-[10px] text-[#917C59] leading-4">
                    <T>এই সংস্করণে SVG Text, font, color, position, image replacement, undo/redo এবং PNG export সমর্থিত। Save এই ব্রাউজারের Local Storage-এ থাকে।</T>
                  </div>
                </div>
              )}
              <div className="border-t border-[#E2D4B9] bg-[#F8F1E4] p-3 grid grid-cols-2 gap-2 shrink-0">
                <button type="button" onClick={() => void saveDesign()} disabled={saving} className="editor-action-primary col-span-2 justify-center disabled:cursor-wait disabled:opacity-70">
                  {saving ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />} <T>Save design</T>{saved && !saving ? <Check size={15} /> : null}
                </button>
                <button type="button" onClick={undo} disabled={historyIndex <= 0} className="editor-action justify-center" aria-label="Undo"><Undo2 size={15} /><T>Undo</T></button>
                <button type="button" onClick={redo} disabled={historyIndex < 0 || historyIndex >= history.length - 1} className="editor-action justify-center" aria-label="Redo"><Redo2 size={15} /><T>Redo</T></button>
                <button type="button" onClick={() => void exportPng()} className="editor-action col-span-2 justify-center"><FileImage size={15} /> PNG</button>
                <button type="button" onClick={() => void printDesign()} className="editor-action col-span-2 justify-center"><FileText size={15} /><T>Print / PDF</T></button>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

