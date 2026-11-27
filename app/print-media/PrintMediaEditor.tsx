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
  Scissors,
  SlidersHorizontal,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type DragEvent as ReactDragEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PRINT_MEDIA_TEMPLATES, type PrintMediaTemplate } from "./templateCatalog";
import { friendlyCutoutError, removePhotoBackground, type CutoutStage } from "./photoCutout";

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
// Auto-saved work-in-progress copy (kept apart from the explicit Save so it never replaces a saved design).
const DRAFT_PREFIX = "sebalagbe-print-media-draft-v1-";
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const BENGALI_RE = /[\u0980-\u09FF]/;
const FONT_CHOICES: Array<{ name: string; value: string; note: string; group: "bn" | "en" }> = [
  { name: "Hind Siliguri", value: '"Hind Siliguri", "Noto Sans Bengali", "Nirmala UI", sans-serif', note: "পরিষ্কার ও আধুনিক", group: "bn" },
  { name: "Tiro Bangla", value: '"Tiro Bangla", "Noto Serif Bengali", serif', note: "ঐতিহ্যবাহী", group: "bn" },
  { name: "Anek Bangla", value: '"Anek Bangla", "Hind Siliguri", "Noto Sans Bengali", sans-serif', note: "আধুনিক শিরোনাম", group: "bn" },
  { name: "Noto Sans Bengali", value: '"Noto Sans Bengali", "Hind Siliguri", sans-serif', note: "স্ট্যান্ডার্ড", group: "bn" },
  { name: "Noto Serif Bengali", value: '"Noto Serif Bengali", "Tiro Bangla", serif', note: "ক্লাসিক", group: "bn" },
  { name: "Baloo Da 2", value: '"Baloo Da 2", "Hind Siliguri", sans-serif', note: "গোলাকার স্টাইল", group: "bn" },
  { name: "Plus Jakarta Sans", value: '"Plus Jakarta Sans", "Inter", sans-serif', note: "", group: "en" },
  { name: "Inter", value: '"Inter", Arial, sans-serif', note: "", group: "en" },
  { name: "Arial", value: "Arial, sans-serif", note: "", group: "en" },
];

// The first family in a font-family string is the font that is really used (the rest are fallbacks).
function firstFontFamily(value: string): string {
  const first = (value || "").split(",")[0] || "";
  return first.replace(/&quot;|["']/g, "").trim();
}

function matchFontChoice(value: string) {
  const name = firstFontFamily(value).toLowerCase();
  return FONT_CHOICES.find((choice) => choice.name.toLowerCase() === name) ?? null;
}

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

// ---- Text resize (drag a corner handle to make the text bigger / smaller) ----
type TextScaleBase = { size: number; stroke: number; spans: { el: Element; size: number }[] };

function readSizeValue(element: Element): number {
  const inline = /font-size\s*:\s*([\d.]+)/.exec(element.getAttribute("style") || "");
  const raw = inline ? inline[1] : element.getAttribute("font-size") || "";
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

function readTextScaleBase(element: Element, computedSize: number): TextScaleBase {
  const spans: { el: Element; size: number }[] = [];
  element.querySelectorAll("tspan").forEach((span) => {
    const size = readSizeValue(span);
    if (size > 0) spans.push({ el: span, size });
  });
  return { size: computedSize, stroke: parseFloat(element.getAttribute("stroke-width") || "") || 0, spans };
}

function writeFontSize(element: Element, size: number) {
  const value = String(Math.round(size * 100) / 100);
  element.setAttribute("font-size", value);
  const inline = element.getAttribute("style") || "";
  if (/font-size\s*:/.test(inline)) element.setAttribute("style", inline.replace(/font-size\s*:\s*[^;]+/, `font-size:${value}px`));
}

function applyTextScale(element: Element, base: TextScaleBase, scale: number) {
  writeFontSize(element, base.size * scale);
  base.spans.forEach((item) => writeFontSize(item.el, item.size * scale));
  if (base.stroke > 0) element.setAttribute("stroke-width", String(Math.round(base.stroke * scale * 100) / 100));
}

// ---- Photo framing: the photo lives inside a fixed frame (the clip shape). The person can drag it
// and zoom it so the face is not cut. The view is stored on the image as data-pm-* attributes:
//   zoom (1 = just covers the frame), cx/cy (0..1 = which part of the photo sits in the frame), nw/nh (natural size).
const PHOTO_MAX_ZOOM = 4;
type PhotoView = { zoom: number; cx: number; cy: number; nw: number; nh: number };

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isFramedPhoto(element: Element | null): boolean {
  return !!element && element.localName.toLowerCase() === "image" && (element.getAttribute("data-layer-name") || "").startsWith("Uploaded image for");
}

function readPhotoFrame(root: ParentNode, image: Element): { x: number; y: number; w: number; h: number } | null {
  const shape = readShape(findClipShape(root, image));
  if (!shape) return null;
  const box = shapeBox(shape);
  return box.w > 0 && box.h > 0 ? box : null;
}

function readPhotoView(image: Element): PhotoView {
  const num = (name: string, fallback: number) => {
    const value = parseFloat(image.getAttribute(name) || "");
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    zoom: clampNumber(num("data-pm-zoom", 1), 1, PHOTO_MAX_ZOOM),
    cx: clampNumber(num("data-pm-cx", 0.5), 0, 1),
    cy: clampNumber(num("data-pm-cy", 0.5), 0, 1),
    nw: num("data-pm-nw", 0),
    nh: num("data-pm-nh", 0),
  };
}

// Sets x/y/width/height so the photo covers the frame at the given zoom and position.
function applyPhotoView(image: Element, frame: { x: number; y: number; w: number; h: number }, view: PhotoView): boolean {
  if (!(view.nw > 0 && view.nh > 0)) return false;
  const zoom = clampNumber(view.zoom, 1, PHOTO_MAX_ZOOM);
  const cx = clampNumber(view.cx, 0, 1);
  const cy = clampNumber(view.cy, 0, 1);
  const cover = Math.max(frame.w / view.nw, frame.h / view.nh) * zoom;
  const w = view.nw * cover;
  const h = view.nh * cover;
  const r = (n: number) => String(Math.round(n * 100) / 100);
  image.setAttribute("preserveAspectRatio", "none");
  image.setAttribute("x", r(frame.x - (w - frame.w) * cx));
  image.setAttribute("y", r(frame.y - (h - frame.h) * cy));
  image.setAttribute("width", r(w));
  image.setAttribute("height", r(h));
  image.setAttribute("data-pm-zoom", String(Math.round(zoom * 1000) / 1000));
  image.setAttribute("data-pm-cx", String(Math.round(cx * 1000) / 1000));
  image.setAttribute("data-pm-cy", String(Math.round(cy * 1000) / 1000));
  image.setAttribute("data-pm-nw", String(view.nw));
  image.setAttribute("data-pm-nh", String(view.nh));
  return true;
}

const PHOTO_VIEW_ATTRS = ["preserveAspectRatio", "x", "y", "width", "height", "data-pm-zoom", "data-pm-cx", "data-pm-cy", "data-pm-nw", "data-pm-nh"];

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
// ---- Simple form mode: every text on the poster becomes a labelled box, every photo frame a photo slot.
// Templates can name things precisely with data-form-field / data-form-label on the SVG element;
// otherwise the label is guessed from the text (phone, ward/union) or numbered.
type FormText = { id: string; label: string; kind: "name" | "ward" | "phone" | "other"; value: string; multiline: boolean; tagged: boolean };
type FormPhoto = { frameId: string; imageId: string | null; label: string; href: string | null };

const FORM_FIELD_LABELS: Record<string, { label: string; kind: FormText["kind"] }> = {
  name: { label: "নাম", kind: "name" },
  candidate: { label: "নাম", kind: "name" },
  ward: { label: "ওয়ার্ড / ইউনিয়ন", kind: "ward" },
  union: { label: "ওয়ার্ড / ইউনিয়ন", kind: "ward" },
  area: { label: "ওয়ার্ড / ইউনিয়ন", kind: "ward" },
  phone: { label: "ফোন নম্বর", kind: "phone" },
  mobile: { label: "ফোন নম্বর", kind: "phone" },
  position: { label: "পদবি", kind: "other" },
  designation: { label: "পদবি", kind: "other" },
  slogan: { label: "স্লোগান", kind: "other" },
  party: { label: "দলের নাম", kind: "other" },
  symbol: { label: "প্রতীক", kind: "other" },
  address: { label: "ঠিকানা", kind: "other" },
};
const PHONE_RE = /(?:\+?(?:88|৮৮))?[0০][1১][3-9৩-৯][\d০-৯\s-]{7,}/;
const PHONE_WORD_RE = /মোবাইল|ফোন|হটলাইন|mobile|phone|call/i;
const WARD_RE = /ওয়ার্ড|ইউনিয়ন|ইউপি|পৌরসভা|উপজেলা|ward|union/i;

const toBanglaDigits = (n: number) => String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]);

function isHiddenInSvg(element: Element, root: Element): boolean {
  let node: Element | null = element;
  while (node && node !== root.parentElement) {
    if (node.getAttribute("display") === "none" || /display\s*:\s*none/.test(node.getAttribute("style") || "")) return true;
    node = node.parentElement;
  }
  return false;
}

function readFormFields(markup: string): { texts: FormText[]; photos: FormPhoto[] } {
  const empty = { texts: [] as FormText[], photos: [] as FormPhoto[] };
  if (!markup || typeof DOMParser === "undefined") return empty;
  try {
    const doc = parseSvg(markup);
    const root = doc.documentElement;
    const found: Array<FormText & { order: number; y: number }> = [];
    let order = 0;
    root.querySelectorAll('text[data-editable="true"]').forEach((element) => {
      const id = element.getAttribute("id") || "";
      if (!id || element.getAttribute("data-form-skip") === "true" || element.getAttribute("data-print") === "false") return;
      if (isInsideNonRender(element, root) || isHiddenInSvg(element, root)) return;
      const value = readTextValue(element);
      if (!value.trim()) return;
      const tag = (element.getAttribute("data-form-field") || "").trim().toLowerCase();
      const known = FORM_FIELD_LABELS[tag];
      const customLabel = element.getAttribute("data-form-label") || "";
      let kind: FormText["kind"] = known?.kind ?? "other";
      let label = customLabel || known?.label || "";
      if (!label) {
        if (PHONE_RE.test(value) || PHONE_WORD_RE.test(value)) {
          kind = "phone";
          label = "ফোন নম্বর";
        } else if (WARD_RE.test(value)) {
          kind = "ward";
          label = "ওয়ার্ড / ইউনিয়ন";
        }
      }
      const y = parseFloat(element.getAttribute("y") || "0") + getMove(element).dy;
      found.push({ id, label, kind, value, multiline: value.includes("\n"), tagged: !!(tag || customLabel), order: order++, y: Number.isFinite(y) ? y : 0 });
    });
    // Named fields first, then everything else from top to bottom of the poster.
    found.sort((a, b) => (a.tagged === b.tagged ? (a.y === b.y ? a.order - b.order : a.y - b.y) : a.tagged ? -1 : 1));
    let counter = 0;
    const texts: FormText[] = found.map((item) => {
      if (!item.label) counter += 1;
      return { id: item.id, label: item.label || `লেখা ${toBanglaDigits(counter)}`, kind: item.kind, value: item.value, multiline: item.multiline, tagged: item.tagged };
    });

    const photos: FormPhoto[] = [];
    let photoNo = 0;
    root.querySelectorAll('[data-object-type="image"]').forEach((frame) => {
      if (frame.localName === "image") return;
      const frameId = frame.getAttribute("id") || "";
      if (!frameId || isInsideNonRender(frame, root)) return;
      const previous = frame.previousElementSibling;
      const filledImage = previous && previous.localName === "image" && (previous.getAttribute("data-layer-name") || "").startsWith("Uploaded image for") ? previous : null;
      if (!filledImage && frame.hasAttribute("data-pm-orig-guide")) return;
      photoNo += 1;
      photos.push({
        frameId,
        imageId: filledImage?.getAttribute("id") || null,
        label: frame.getAttribute("data-form-label") || `ছবি ${toBanglaDigits(photoNo)}`,
        href: filledImage ? filledImage.getAttribute("href") || filledImage.getAttribute("xlink:href") : null,
      });
    });
    return { texts, photos };
  } catch {
    return empty;
  }
}

// A text box that keeps what the person types, waits for a short pause (and for Bangla keyboards to finish
// composing a letter) before it changes the poster, so typing never jumps or drops letters.
function FormTextField({ value, label, multiline, onFocusField, onCommit }: { value: string; label: string; multiline: boolean; onFocusField: () => void; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const composing = useRef(false);
  const timer = useRef<number | null>(null);
  const latest = useRef(value);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => {
    if (!focused) {
      setDraft(value);
      latest.current = value;
    }
  }, [value, focused]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const flush = (next: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (next !== latest.current) {
      latest.current = next;
      commitRef.current(next);
    }
  };
  const schedule = (next: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(next), 450);
  };
  const common = {
    value: draft,
    className: "w-full rounded-lg border border-[#D9C7A5] bg-white px-3 py-2 text-[13px] text-[#332A1D] outline-none focus:border-[#DC2626] focus:ring-2 focus:ring-[#DC2626]/15",
    onFocus: () => {
      setFocused(true);
      onFocusField();
    },
    onBlur: () => {
      setFocused(false);
      flush(draft);
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: { currentTarget: { value: string } }) => {
      composing.current = false;
      setDraft(event.currentTarget.value);
      schedule(event.currentTarget.value);
    },
  };
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-[#6F5B3C]">{label}</span>
      {multiline ? (
        <textarea
          {...common}
          rows={3}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setDraft(event.target.value);
            if (!composing.current) schedule(event.target.value);
          }}
        />
      ) : (
        <input
          type="text"
          {...common}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setDraft(event.target.value);
            if (!composing.current) schedule(event.target.value);
          }}
        />
      )}
    </label>
  );
}

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
  const deleteSelectedRef = useRef<() => void>(() => {});
  const copySelectedRef = useRef<() => void>(() => {});
  const pasteSelectedRef = useRef<() => void>(() => {});
  const duplicateSelectedRef = useRef<() => void>(() => {});
  // Internal clipboard for Ctrl+C / Ctrl+V: the serialized layer plus how many times it was pasted.
  const clipboardRef = useRef<{ markup: string; pasteCount: number } | null>(null);
  // Unsaved-changes tracking + auto-saved draft.
  const baselineRef = useRef("");
  const latestMarkupRef = useRef("");
  const draftKeyRef = useRef("");
  const [draftOffer, setDraftOffer] = useState<{ svgMarkup: string; updatedAt: string } | null>(null);
  const draftOfferRef = useRef<{ svgMarkup: string; updatedAt: string } | null>(null);
  latestMarkupRef.current = svgMarkup;
  draftOfferRef.current = draftOffer;
  const hasUnsavedChanges = () => !!latestMarkupRef.current && !!baselineRef.current && latestMarkupRef.current !== baselineRef.current;

  // Warn before closing / refreshing the tab while there is unsaved work.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Auto-save a draft a couple of seconds after every change. Paused while the restore question is open.
  useEffect(() => {
    if (!svgMarkup || !baselineRef.current || !draftKeyRef.current || draftOffer) return;
    const key = draftKeyRef.current;
    if (svgMarkup === baselineRef.current) {
      try { window.localStorage.removeItem(key); } catch { /* ignore */ }
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(key, JSON.stringify({ svgMarkup, updatedAt: new Date().toISOString() }));
      } catch {
        // Storage full or blocked: the editor keeps working, only the draft is skipped.
      }
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [svgMarkup, saved, draftOffer]);

  const restoreDraft = () => {
    const offer = draftOfferRef.current;
    if (!offer) return;
    try {
      const restored = makeAllEditable(applyTypographyDefaults(sanitizeSvg(offer.svgMarkup)));
      setDraftOffer(null);
      commitSvg(restored);
      setSelectedId("");
    } catch {
      setDraftOffer(null);
      setError("আগের কাজটি ফিরিয়ে আনা যায়নি।");
    }
  };
  const discardDraft = () => {
    try { window.localStorage.removeItem(draftKeyRef.current); } catch { /* ignore */ }
    setDraftOffer(null);
  };
  const goBackToTemplates = () => {
    if (hasUnsavedChanges() && !window.confirm("আপনার পরিবর্তনগুলো এখনো সেভ হয়নি। সেভ না করেই বের হবেন?")) return;
    router.push("/print-media");
  };

  const printWrapRef = useRef<HTMLDivElement>(null);
  const [selBox, setSelBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // Empty photo frames get an on-canvas upload button and accept dropped files.
  type EmptyFrame = { id: string; left: number; top: number; width: number; height: number };
  const [emptyFrames, setEmptyFrames] = useState<EmptyFrame[]>([]);
  const [dropFrameId, setDropFrameId] = useState("");
  const pendingFrameRef = useRef("");

  const measureEmptyFrames = () => {
    const wrap = printWrapRef.current;
    const svg = svgContainerRef.current?.querySelector("svg");
    if (!wrap || !svg) {
      setEmptyFrames([]);
      return;
    }
    const base = wrap.getBoundingClientRect();
    const next: EmptyFrame[] = [];
    svg.querySelectorAll('[data-object-type="image"]').forEach((frame) => {
      if (frame.localName === "image" || frame.hasAttribute("data-pm-orig-guide")) return;
      const previous = frame.previousElementSibling;
      if (previous && previous.localName === "image" && (previous.getAttribute("data-layer-name") || "").startsWith("Uploaded image for")) return;
      const id = frame.getAttribute("id");
      if (!id) return;
      const rect = frame.getBoundingClientRect();
      if (rect.width < 14 || rect.height < 14) return;
      next.push({ id, left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height });
    });
    setEmptyFrames((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  };

  useLayoutEffect(() => {
    measureEmptyFrames();
  }, [svgMarkup, zoom, loading]);

  useEffect(() => {
    if (loading) return;
    const onResize = () => measureEmptyFrames();
    window.addEventListener("resize", onResize);
    const container = svgContainerRef.current;
    const observer = typeof ResizeObserver !== "undefined" && container ? new ResizeObserver(onResize) : null;
    if (observer && container) observer.observe(container);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [loading]);

  const openUploadFor = (frameId: string, replaceImageId = "") => {
    pendingFrameRef.current = frameId;
    pendingReplaceRef.current = replaceImageId ? { frameId, imageId: replaceImageId } : null;
    setSelectedId(frameId);
    imageInputRef.current?.click();
  };

  const frameAtPoint = (clientX: number, clientY: number): string => {
    const wrap = printWrapRef.current;
    if (!wrap) return "";
    const base = wrap.getBoundingClientRect();
    const x = clientX - base.left;
    const y = clientY - base.top;
    const hits = emptyFrames.filter((f) => x >= f.left && x <= f.left + f.width && y >= f.top && y <= f.top + f.height);
    if (hits.length) return hits.sort((a, b) => a.width * a.height - b.width * b.height)[0].id;
    if (emptyFrames.length === 1) return emptyFrames[0].id;
    const selectedEmpty = emptyFrames.find((f) => f.id === selectedId);
    return selectedEmpty ? selectedEmpty.id : "";
  };

  const hasFiles = (event: ReactDragEvent<HTMLDivElement>) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const handleWrapDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const id = frameAtPoint(event.clientX, event.clientY);
    setDropFrameId((current) => (current === id ? current : id));
  };

  const handleWrapDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropFrameId("");
  };

  const handleWrapDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const id = frameAtPoint(event.clientX, event.clientY);
    setDropFrameId("");
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!id) {
      setError("ছবিটি যে ফ্রেমে বসাতে চান, তার ওপর ছেড়ে দিন।");
      return;
    }
    setSelectedId(id);
    placeImageFile(file, id);
  };

  const findLiveElement = (id: string): SVGGraphicsElement | null => {
    const svg = svgContainerRef.current?.querySelector("svg");
    if (!svg || !id) return null;
    const found = Array.from(svg.querySelectorAll("[id]")).find((element) => element.getAttribute("id") === id);
    return (found as SVGGraphicsElement | undefined) ?? null;
  };

  // ---- photo framing + background removal state
  const updateElementByIdRef = useRef<(id: string, attribute: string, value: string) => void>(() => {});
  const pendingReplaceRef = useRef<{ frameId: string; imageId: string } | null>(null);
  const [leftTab, setLeftTab] = useState<"form" | "layers">("form");
  const [showAllTexts, setShowAllTexts] = useState(false);
  const formFields = useMemo(() => readFormFields(svgMarkup), [svgMarkup]);
  const photoMetaRef = useRef(new Map<string, { nw: number; nh: number }>());
  const photoZoomDirtyRef = useRef(false);
  const commitSvgRef = useRef<(markup: string) => void>(() => {});
  const [photoUi, setPhotoUi] = useState<{ zoom: number; cutout: boolean; ready: boolean } | null>(null);
  const [cutoutBusy, setCutoutBusy] = useState<{ id: string; stage: CutoutStage; percent: number | null } | null>(null);
  const [cutoutError, setCutoutError] = useState("");

  const getPhotoMeta = (element: Element, id: string): { nw: number; nh: number } | null => {
    const view = readPhotoView(element);
    if (view.nw > 0 && view.nh > 0) return { nw: view.nw, nh: view.nh };
    return photoMetaRef.current.get(id) ?? null;
  };

  // Places the four resize handles on the selected image / frame / shape.
  const updateSelBox = (idOverride?: string) => {
    const wrap = printWrapRef.current;
    const svg = svgContainerRef.current?.querySelector("svg");
    const element = findLiveElement(idOverride ?? selectedId);
    if (!wrap || !svg || !element || !(RESIZE_ATTRS[element.localName.toLowerCase()] || element.localName.toLowerCase() === "text")) {
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
    const base = wrap.getBoundingClientRect();
    if (isFramedPhoto(element)) {
      // Show the frame, not the (bigger) zoomed photo behind it.
      const frame = readPhotoFrame(svg, element);
      const ctm = element.getScreenCTM();
      if (frame && ctm) {
        const left = ctm.a * frame.x + ctm.c * frame.y + ctm.e;
        const top = ctm.b * frame.x + ctm.d * frame.y + ctm.f;
        setSelBox({ left: left - base.left, top: top - base.top, width: ctm.a * frame.w, height: ctm.d * frame.h });
        return;
      }
    }
    const rect = element.getBoundingClientRect();
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

    // Text: dragging a corner changes the font size; the opposite corner stays where it is.
    if (liveElement.localName.toLowerCase() === "text") {
      const parentMatrix = (liveElement.parentNode as SVGGraphicsElement | null)?.getScreenCTM?.();
      if (!parentMatrix) return;
      const inv = parentMatrix.inverse();
      const startRect = liveElement.getBoundingClientRect();
      const computed = parseFloat(window.getComputedStyle(liveElement).fontSize) || readSizeValue(liveElement);
      if (startRect.width <= 0 || startRect.height <= 0 || !(computed > 0)) return;
      const textBase = readTextScaleBase(liveElement, computed);
      const isEast = corner.includes("e");
      const isSouth = corner.includes("s");
      const anchorX = isEast ? startRect.left : startRect.right;
      const anchorY = isSouth ? startRect.top : startRect.bottom;
      const originX = event.clientX;
      const originY = event.clientY;
      const startMove = getMove(liveElement);
      let curDx = startMove.dx;
      let curDy = startMove.dy;
      let textScale = 1;

      const onTextMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const sx = ((isEast ? 1 : -1) * (moveEvent.clientX - originX) + startRect.width) / startRect.width;
        const sy = ((isSouth ? 1 : -1) * (moveEvent.clientY - originY) + startRect.height) / startRect.height;
        textScale = Math.min(12, Math.max(0.1, Math.max(sx, sy)));
        applyTextScale(liveElement, textBase, textScale);
        const rect = liveElement.getBoundingClientRect();
        const shiftX = anchorX - (isEast ? rect.left : rect.right);
        const shiftY = anchorY - (isSouth ? rect.top : rect.bottom);
        curDx += inv.a * shiftX + inv.c * shiftY;
        curDy += inv.b * shiftX + inv.d * shiftY;
        setMove(liveElement, curDx, curDy);
        updateSelBox(id);
      };
      const onTextUp = () => {
        window.removeEventListener("pointermove", onTextMove);
        window.removeEventListener("pointerup", onTextUp);
        window.removeEventListener("pointercancel", onTextUp);
        if (Math.abs(textScale - 1) < 0.001) return;
        try {
          const doc = parseSvg(svgMarkup);
          const docElement = findSvgElement(doc, id);
          if (!docElement) return;
          // The person chose this size on purpose: stop auto-fitting this text.
          docElement.removeAttribute("data-pm-maxw");
          docElement.removeAttribute("data-pm-fs");
          applyTextScale(docElement, readTextScaleBase(docElement, computed), textScale);
          setMove(docElement, curDx, curDy);
          commitSvg(serializeSvg(doc));
        } catch {
          setError("Could not resize the text.");
        }
      };
      window.addEventListener("pointermove", onTextMove, { passive: false });
      window.addEventListener("pointerup", onTextUp);
      window.addEventListener("pointercancel", onTextUp);
      return;
    }

    const primary = readShape(liveElement);
    if (!primary) return;
    const liveClip = readShape(findClipShape(svg, liveElement));
    const box = isFramedPhoto(liveElement) && liveClip ? shapeBox(liveClip) : shapeBox(primary);
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
  // Reads the selected photo's zoom for the panel, and learns its natural size when an older design lacks it.
  useEffect(() => {
    const element = selectedId ? findLiveElement(selectedId) : null;
    const root = svgContainerRef.current;
    if (!element || !root || !isFramedPhoto(element) || !findClipShape(root, element)) {
      setPhotoUi(null);
      return;
    }
    const view = readPhotoView(element);
    const known = (view.nw > 0 && view.nh > 0) || photoMetaRef.current.has(selectedId);
    setPhotoUi({ zoom: view.zoom, cutout: element.getAttribute("data-pm-cutout") === "1", ready: known });
    if (known) return;
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (cancelled || !(probe.naturalWidth > 0)) return;
      photoMetaRef.current.set(selectedId, { nw: probe.naturalWidth, nh: probe.naturalHeight });
      setPhotoUi((current) => (current ? { ...current, ready: true } : current));
    };
    probe.src = element.getAttribute("href") || element.getAttribute("xlink:href") || "";
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, svgMarkup]);

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
        setDraftOffer(null);

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
        baselineRef.current = initialSvg;
        draftKeyRef.current = `${DRAFT_PREFIX}${templateId}${loadedFromCloud ? `-${cloudFileIdRef.current}` : ""}`;
        setSvgMarkup(initialSvg);
        setHistory([initialSvg]);
        setHistoryIndex(0);
        setSaved(false);
        if (loadNotice) setError(loadNotice);
        // An auto-saved draft from an earlier session (crash, power cut, closed tab)? Offer to bring it back.
        try {
          const rawDraft = window.localStorage.getItem(draftKeyRef.current);
          if (rawDraft) {
            const draft = JSON.parse(rawDraft) as { svgMarkup?: string; updatedAt?: string };
            const age = draft.updatedAt ? Date.now() - new Date(draft.updatedAt).getTime() : Infinity;
            if (draft.svgMarkup && draft.svgMarkup !== initialSvg && age < DRAFT_MAX_AGE_MS) {
              setDraftOffer({ svgMarkup: draft.svgMarkup, updatedAt: draft.updatedAt || "" });
            } else {
              window.localStorage.removeItem(draftKeyRef.current);
            }
          }
        } catch {
          // Draft recovery is optional.
        }
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
      if ((event.key === "Delete" || event.key === "Backspace") && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Delete / Backspace removes the selected layer directly from the canvas.
        event.preventDefault();
        deleteSelectedRef.current();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ["c", "v", "d"].includes(event.key.toLowerCase())) {
        const key = event.key.toLowerCase();
        if (key === "c") {
          // Leave normal browser copy alone when the user has highlighted some page text.
          if ((window.getSelection()?.toString() || "").length > 0) return;
          copySelectedRef.current();
        } else if (key === "v") {
          pasteSelectedRef.current();
        } else {
          event.preventDefault(); // Ctrl+D would otherwise bookmark the page.
          duplicateSelectedRef.current();
        }
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
  commitSvgRef.current = commitSvg;

  // ---- photo framing actions
  const applyPhotoLive = (id: string, patch: Partial<PhotoView>) => {
    const element = findLiveElement(id);
    const root = svgContainerRef.current;
    if (!element || !root) return false;
    const frame = readPhotoFrame(root, element);
    const meta = getPhotoMeta(element, id);
    if (!frame || !meta) return false;
    const next: PhotoView = { ...readPhotoView(element), nw: meta.nw, nh: meta.nh, ...patch };
    if (!applyPhotoView(element, frame, next)) return false;
    setPhotoUi((current) => (current ? { ...current, zoom: clampNumber(next.zoom, 1, PHOTO_MAX_ZOOM) } : current));
    updateSelBox(id);
    return true;
  };

  // Copies the live photo position/zoom into the saved markup (one undo step).
  const commitPhotoFromLive = (id: string) => {
    const element = findLiveElement(id);
    if (!element || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const target = findSvgElement(doc, id);
      if (!target) return;
      for (const name of PHOTO_VIEW_ATTRS) {
        const value = element.getAttribute(name);
        if (value !== null) target.setAttribute(name, value);
      }
      commitSvg(serializeSvg(doc));
    } catch {
      setError("Could not update the photo.");
    }
  };

  const previewPhotoZoom = (value: number) => {
    if (!selectedId) return;
    photoZoomDirtyRef.current = true;
    applyPhotoLive(selectedId, { zoom: value });
  };

  const commitPhotoZoom = () => {
    if (!photoZoomDirtyRef.current || !selectedId) return;
    photoZoomDirtyRef.current = false;
    commitPhotoFromLive(selectedId);
  };

  const resetPhotoView = () => {
    if (!selectedId) return;
    if (applyPhotoLive(selectedId, { zoom: 1, cx: 0.5, cy: 0.5 })) commitPhotoFromLive(selectedId);
  };

  // One click: removes the photo background with the same AI as the Remove Background tool.
  const removeSelectedBackground = async () => {
    const id = selectedId;
    if (!id || cutoutBusy) return;
    const element = findLiveElement(id);
    const href = element?.getAttribute("href") || element?.getAttribute("xlink:href") || "";
    if (!href.startsWith("data:")) {
      setCutoutError("এই ছবির ব্যাকগ্রাউন্ড মোছা যাচ্ছে না। ছবিটি আবার আপলোড করে চেষ্টা করুন।");
      return;
    }
    setCutoutError("");
    setCutoutBusy({ id, stage: "download", percent: null });
    try {
      const result = await removePhotoBackground(href, (stage, percent) => {
        setCutoutBusy((current) => (current && current.id === id ? { id, stage, percent } : current));
      });
      const doc = parseSvg(latestMarkupRef.current);
      const target = findSvgElement(doc, id);
      if (!target) return;
      target.removeAttribute("xlink:href");
      target.setAttribute("href", result);
      target.setAttribute("data-pm-cutout", "1");
      commitSvgRef.current(serializeSvg(doc));
    } catch (cutoutFailure) {
      console.error("[Print Media] Background removal failed:", cutoutFailure);
      setCutoutError(friendlyCutoutError(cutoutFailure));
    } finally {
      setCutoutBusy(null);
    }
  };

  const updateElementById = (targetId: string, attribute: string, value: string) => {
    if (!targetId || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, targetId);
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
        nextMarkup = autoFitText(nextMarkup, "fit", targetId);
      }
      commitSvg(nextMarkup);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update this element.");
    }
  };

  const updateSelected = (attribute: string, value: string) => updateElementById(selectedId, attribute, value);
  updateElementByIdRef.current = updateElementById;

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

    // A photo inside its frame: dragging pans the photo inside the frame (hold Shift to move the whole photo).
    if (isFramedPhoto(editable) && !event.shiftKey) {
      const frame = readPhotoFrame(container, editable);
      const meta = getPhotoMeta(editable, id);
      const parentMatrix = (editable.parentNode as SVGGraphicsElement | null)?.getScreenCTM?.();
      if (frame && meta && parentMatrix && parentMatrix.a && parentMatrix.d) {
        const startView: PhotoView = { ...readPhotoView(editable), nw: meta.nw, nh: meta.nh };
        if (!editable.hasAttribute("data-pm-nw")) applyPhotoView(editable, frame, startView);
        const startX = event.clientX;
        const startY = event.clientY;
        const cover = Math.max(frame.w / meta.nw, frame.h / meta.nh) * startView.zoom;
        const spareX = meta.nw * cover - frame.w;
        const spareY = meta.nh * cover - frame.h;
        let panned = false;
        const onPanMove = (moveEvent: PointerEvent) => {
          if (!panned && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 3) return;
          panned = true;
          moveEvent.preventDefault();
          const dx = (moveEvent.clientX - startX) / parentMatrix.a;
          const dy = (moveEvent.clientY - startY) / parentMatrix.d;
          applyPhotoLive(id, {
            cx: spareX > 0.5 ? clampNumber(startView.cx - dx / spareX, 0, 1) : startView.cx,
            cy: spareY > 0.5 ? clampNumber(startView.cy - dy / spareY, 0, 1) : startView.cy,
          });
        };
        const onPanUp = () => {
          window.removeEventListener("pointermove", onPanMove);
          window.removeEventListener("pointerup", onPanUp);
          window.removeEventListener("pointercancel", onPanUp);
          if (!panned) return;
          suppressClickRef.current = true;
          window.setTimeout(() => { suppressClickRef.current = false; }, 0);
          commitPhotoFromLive(id);
        };
        window.addEventListener("pointermove", onPanMove, { passive: false });
        window.addEventListener("pointerup", onPanUp);
        window.addEventListener("pointercancel", onPanUp);
        return;
      }
    }

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
    const frameId = pendingFrameRef.current || selectedId;
    pendingFrameRef.current = "";
    const replace = pendingReplaceRef.current && pendingReplaceRef.current.frameId === frameId ? pendingReplaceRef.current.imageId : "";
    pendingReplaceRef.current = null;
    if (file) placeImageFile(file, frameId, replace);
  };

  const placeImageFile = (file: File, frameId: string, replaceImageId = "") => {
    if (!file || !frameId || !svgMarkup) return;
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
      const dataUrl = reader.result;
      const probe = new Image();
      probe.onload = () => build(probe.naturalWidth, probe.naturalHeight);
      probe.onerror = () => build(0, 0);
      probe.src = dataUrl;
      const build = (naturalW: number, naturalH: number) => {
      try {
        const doc = parseSvg(svgMarkup);
        const frame = findSvgElement(doc, frameId);
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

        if (replaceImageId) {
          // Changing a photo: remove the old one (and its clip) so the new photo takes its place.
          const old = findSvgElement(doc, replaceImageId);
          if (old && old.localName === "image") {
            findClipShape(doc, old)?.parentElement?.remove();
            old.remove();
          }
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
        image.setAttribute("data-layer-name", `Uploaded image for ${frame.getAttribute("data-layer-name") || frameId}`);
        image.setAttribute("data-editable", "true");
        image.setAttribute("data-object-type", "image");
        image.setAttribute("href", dataUrl);
        image.setAttribute("x", String(x));
        image.setAttribute("y", String(y));
        image.setAttribute("width", String(width));
        image.setAttribute("height", String(height));
        image.setAttribute("preserveAspectRatio", "xMidYMid slice");
        image.setAttribute("clip-path", `url(#${clipId})`);
        // Cover the frame at zoom 1 with the photo centred; the person can then drag and zoom it.
        applyPhotoView(image, { x, y, w: width, h: height }, { zoom: 1, cx: 0.5, cy: 0.5, nw: naturalW, nh: naturalH });
        frame.parentNode?.insertBefore(image, frame);
        hideFrameGuide(frame);

        const hint = findSvgElement(doc, `${frameId}_hint`);
        hint?.setAttribute("display", "none");
        if (frameId === "qr_image_placeholder") {
          findSvgElement(doc, "qr_hint_text")?.setAttribute("display", "none");
        }

        commitSvg(serializeSvg(doc));
        setSelectedId(image.getAttribute("id") || "");
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "Could not place this image.");
      }
      };
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
  deleteSelectedRef.current = deleteSelected;

  // Copy / paste / duplicate of the selected layer. The copy gets fresh ids and a small offset.
  const copySelected = () => {
    if (!selectedId || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, selectedId);
      if (!element || element.id === "background") return;
      clipboardRef.current = { markup: new XMLSerializer().serializeToString(element), pasteCount: 0 };
    } catch {
      setError("Could not copy this layer.");
    }
  };
  const pasteFromMarkup = (markup: string, offset: number, parentSource?: Element | null) => {
    if (!svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const holder = parseSvg(`<svg xmlns="${SVG_NS}">${markup}</svg>`);
      const source = holder.documentElement.firstElementChild;
      if (!source) return;
      const clone = doc.importNode(source, true) as Element;
      const stamp = Date.now();
      let counter = 0;
      const renew = (node: Element) => {
        if (node.hasAttribute("id")) node.setAttribute("id", `${(node.getAttribute("id") || "layer").replace(/-copy-\d+(-\d+)?$/, "")}-copy-${stamp}-${counter++}`);
        node.removeAttribute("data-pm-orig-guide");
      };
      renew(clone);
      clone.querySelectorAll("[id]").forEach(renew);
      const originalName = clone.getAttribute("data-layer-name");
      if (originalName) clone.setAttribute("data-layer-name", `${originalName} copy`);
      const move = getMove(clone);
      setMove(clone, move.dx + offset, move.dy + offset);
      const parent = parentSource?.parentNode ?? doc.documentElement;
      parent.appendChild(clone);
      commitSvg(serializeSvg(doc));
      setSelectedId(clone.getAttribute("id") || "");
    } catch {
      setError("Could not paste this layer.");
    }
  };
  const pasteSelected = () => {
    const clip = clipboardRef.current;
    if (!clip) return;
    clip.pasteCount += 1;
    pasteFromMarkup(clip.markup, 20 * clip.pasteCount);
  };
  const duplicateSelected = () => {
    if (!selectedId || !svgMarkup) return;
    try {
      const doc = parseSvg(svgMarkup);
      const element = findSvgElement(doc, selectedId);
      if (!element || element.id === "background") return;
      pasteFromMarkup(new XMLSerializer().serializeToString(element), 20, element);
    } catch {
      setError("Could not duplicate this layer.");
    }
  };
  copySelectedRef.current = copySelected;
  pasteSelectedRef.current = pasteSelected;
  duplicateSelectedRef.current = duplicateSelected;

  // Double-clicking a text layer on the canvas jumps straight into its text box.
  const handleCanvasDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const editable = target.closest('[data-editable="true"]');
    const tag = editable?.localName;
    if (!editable || (tag !== "text" && tag !== "tspan")) return;
    setShowProperties(true);
    window.setTimeout(() => {
      textAreaRef.current?.focus();
      textAreaRef.current?.select();
    }, 60);
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
      baselineRef.current = markup; // everything up to here is safely saved
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
          <button type="button" onClick={goBackToTemplates} className="w-10 h-10 rounded-xl border border-[#E2D4B9] bg-white text-[#5B4A31] hover:text-[#DC2626] hover:border-[#DC2626] flex items-center justify-center shrink-0" aria-label="Back to templates">
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
            <aside className="order-2 xl:order-1 bg-[#F8F1E4] border border-[#E2D4B9] rounded-2xl shadow-sm overflow-hidden">
              <div data-pm-keep-selection="true" className="grid grid-cols-2 border-b border-[#E2D4B9] bg-[#F3E8D3] p-1 gap-1">
                <button type="button" onClick={() => setLeftTab("form")} className={`rounded-lg py-2 text-[12px] font-extrabold transition ${leftTab === "form" ? "bg-white text-[#DC2626] shadow-sm" : "text-[#7A6A4C] hover:text-[#DC2626]"}`}><T>সহজ ফর্ম</T></button>
                <button type="button" onClick={() => setLeftTab("layers")} className={`rounded-lg py-2 text-[12px] font-extrabold transition ${leftTab === "layers" ? "bg-white text-[#DC2626] shadow-sm" : "text-[#7A6A4C] hover:text-[#DC2626]"}`}><T>বিস্তারিত এডিট</T></button>
              </div>
              {leftTab === "form" ? (
                <div data-pm-keep-selection="true" className="p-3 space-y-4 max-h-[70vh] overflow-y-auto">
                  <p className="text-[11px] leading-4 text-[#7A6A4C]"><T>এখানে লিখলেই পোস্টারে বদলে যাবে। ছবি, রং বা জায়গা বদলাতে চাইলে “বিস্তারিত এডিট” ট্যাবে যান।</T></p>
                  {formFields.photos.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-extrabold text-[#5D4B31]"><T>ছবি</T></p>
                      <div className="grid grid-cols-2 gap-2">
                        {formFields.photos.map((photo) => (
                          <button
                            type="button"
                            key={photo.frameId}
                            onClick={() => openUploadFor(photo.frameId, photo.imageId || "")}
                            className="group relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-[#D9B98A] bg-white text-[#A06A32] hover:border-[#DC2626] hover:text-[#DC2626]"
                          >
                            {photo.href ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={photo.href} alt={photo.label} className="absolute inset-0 h-full w-full object-cover" />
                            ) : (
                              <Upload size={20} />
                            )}
                            <span className={`relative mt-1 rounded-md px-2 py-0.5 text-[11px] font-bold ${photo.href ? "bg-black/60 text-white" : ""}`}>
                              {photo.href ? <T>ছবি বদলান</T> : <>{photo.label} · <T>ছবি দিন</T></>}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {formFields.texts.length > 0 ? (
                    <div className="space-y-3">
                      <p className="text-xs font-extrabold text-[#5D4B31]"><T>লেখা</T></p>
                      {(showAllTexts ? formFields.texts : formFields.texts.slice(0, 8)).map((field) => (
                        <FormTextField
                          key={field.id}
                          label={field.label}
                          value={field.value}
                          multiline={field.multiline}
                          onFocusField={() => setSelectedId(field.id)}
                          onCommit={(next) => updateElementByIdRef.current(field.id, "textContent", next)}
                        />
                      ))}
                      {formFields.texts.length > 8 && (
                        <button type="button" onClick={() => setShowAllTexts((value) => !value)} className="w-full rounded-xl border border-[#D9C7A5] bg-white py-2 text-xs font-bold text-[#785B32] hover:border-[#DC2626] hover:text-[#DC2626]">
                          {showAllTexts ? <T>কম দেখান</T> : <><T>আরও লেখা দেখান</T> ({formFields.texts.length - 8})</>}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-[#927D5B]"><T>এই ডিজাইনে বদলানোর মতো লেখা পাওয়া যায়নি।</T></p>
                  )}
                </div>
              ) : (
              <>
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
              </>
              )}
            </aside>

            <main className="order-1 xl:order-2 min-w-0 space-y-3">
              {draftOffer && (
                <div className="rounded-2xl border border-[#F0C98F] bg-[#FFF6E5] px-4 py-3 text-[12px] text-[#5C4B32]">
                  <p className="font-bold text-[#C2410C]"><T>আগের অসম্পূর্ণ কাজ পাওয়া গেছে</T></p>
                  <p className="mt-1"><T>এই ডিজাইনে আপনার আগের কাজ অটো-সেভ করা আছে। ফিরিয়ে আনবেন?</T></p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={restoreDraft} className="rounded-lg bg-[#DC2626] px-3 py-1.5 text-[11px] font-bold text-white hover:bg-[#B91C1C]"><T>হ্যাঁ, ফিরিয়ে আনুন</T></button>
                    <button type="button" onClick={discardDraft} className="rounded-lg border border-[#E2D4B9] bg-white px-3 py-1.5 text-[11px] font-bold text-[#5C4B32] hover:bg-[#F7DDB8]"><T>না, নতুন করে শুরু করব</T></button>
                  </div>
                </div>
              )}
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
                <div ref={printWrapRef} className="relative" style={{ flexShrink: 0 }} onDragOver={handleWrapDragOver} onDragLeave={handleWrapDragLeave} onDrop={handleWrapDrop}>
                  <div
                    id="pm-print-area"
                    ref={svgContainerRef}
                    onClick={handleSvgClick}
                    onDoubleClick={handleCanvasDoubleClick}
                    onPointerDown={handleCanvasPointerDown}
                    className="pm-canvas bg-white shadow-[0_12px_40px_rgba(52,40,20,.18)] ring-1 ring-black/10"
                    style={{ ...canvasStyle, width: `${Math.round(760 * zoom / 100)}px`, flexShrink: 0 }}
                    dangerouslySetInnerHTML={{ __html: svgMarkup }}
                  />
                  {emptyFrames.map((frame) => {
                    const active = dropFrameId === frame.id;
                    const minDim = Math.min(frame.width, frame.height);
                    const iconOnly = frame.width < 130 || frame.height < 100;
                    const compact = frame.width < 190 || frame.height < 130;
                    const iconSize = Math.max(10, Math.min(30, Math.round(minDim - 8)));
                    return (
                      <div
                        key={frame.id}
                        data-pm-keep-selection="true"
                        className={`absolute pointer-events-none transition ${active ? "bg-[#DC2626]/15 outline outline-2 outline-dashed outline-[#DC2626]" : ""}`}
                        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
                      >
                        {iconOnly ? (
                          <button
                            type="button"
                            data-pm-keep-selection="true"
                            title="ছবি আপলোড করুন"
                            aria-label="ছবি আপলোড করুন"
                            onClick={(event) => { event.stopPropagation(); openUploadFor(frame.id); }}
                            className="pointer-events-auto absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#DC2626]/50 bg-white/95 text-[#DC2626] shadow hover:bg-[#FFF1F1] hover:border-[#DC2626]"
                            style={{ width: iconSize, height: iconSize }}
                          >
                            <Upload size={Math.max(8, Math.round(iconSize * 0.55))} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-pm-keep-selection="true"
                            onClick={(event) => { event.stopPropagation(); openUploadFor(frame.id); }}
                            className="pointer-events-auto absolute left-1/2 top-[68%] -translate-x-1/2 -translate-y-1/2 flex max-w-[92%] flex-col items-center gap-0.5 rounded-xl border border-[#DC2626]/40 bg-white/95 px-3 py-2 text-center shadow-md hover:bg-[#FFF1F1] hover:border-[#DC2626]"
                          >
                            <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[#DC2626]">
                              <Upload size={14} /> {active ? <T>এখানে ছেড়ে দিন</T> : <T>ছবি আপলোড করুন</T>}
                            </span>
                            {!compact && <span className="text-[10px] leading-4 text-[#7A6A4C]"><T>ক্লিক করুন অথবা ছবি টেনে এনে ছেড়ে দিন</T></span>}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {selBox && (["nw", "ne", "sw", "se"] as const).map((corner) => (
                    <div
                      key={corner}
                      data-pm-keep-selection="true"
                      onPointerDown={startResize(corner)}
                      className="pm-resize-handle"
                      title="টেনে সাইজ বড়/ছোট করুন"
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

            <aside className="order-3 bg-[#F8F1E4] border border-[#E2D4B9] rounded-2xl shadow-sm overflow-hidden flex flex-col xl:sticky xl:top-[136px] xl:max-h-[calc(100vh-148px)]">
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
                            {(() => {
                              const rawFamily = selectedLayer.fontFamily || FONT_CHOICES[0].value;
                              const current = matchFontChoice(rawFamily);
                              const currentName = current?.name || firstFontFamily(rawFamily) || FONT_CHOICES[0].name;
                              return (
                                <>
                                  <div className="flex items-center justify-between gap-2 rounded-lg border border-[#E7C9C9] bg-[#FFF5F5] px-3 py-2">
                                    <span className="text-[10px] font-bold text-[#917C59]">এখন ব্যবহার হচ্ছে</span>
                                    <span className="text-sm font-bold text-[#DC2626] truncate" style={{ fontFamily: rawFamily }}>{currentName}</span>
                                  </div>
                                  <select value={current ? current.value : rawFamily} onChange={(event: ChangeEvent<HTMLSelectElement>) => updateSelected("font-family", event.target.value)} className="pm-property-input">
                                    {!current && <option value={rawFamily}>{currentName}</option>}
                                    <optgroup label="বাংলা ফন্ট">
                                      {FONT_CHOICES.filter((choice) => choice.group === "bn").map((choice) => (
                                        <option key={choice.name} value={choice.value}>{choice.name} — {choice.note}</option>
                                      ))}
                                    </optgroup>
                                    <optgroup label="English fonts">
                                      {FONT_CHOICES.filter((choice) => choice.group === "en").map((choice) => (
                                        <option key={choice.name} value={choice.value}>{choice.name}</option>
                                      ))}
                                    </optgroup>
                                  </select>
                                </>
                              );
                            })()}
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
                      {photoUi && (
                        <div data-pm-keep-selection="true" className="space-y-3 rounded-xl border border-[#E2D4B9] bg-[#FFFBF2] p-3">
                          <p className="text-xs font-extrabold text-[#5D4B31]"><T>ছবি ঠিক করুন</T></p>
                          <p className="text-[11px] leading-4 text-[#7A6A4C]"><T>ছবির ওপর আঙুল বা মাউস দিয়ে টেনে মুখ ঠিক জায়গায় আনুন। নিচের স্লাইডারে ছবি ছোট-বড় করুন।</T></p>
                          <label className="block">
                            <span className="text-xs font-bold text-[#6F5B3C]"><T>জুম</T> · {Math.round(photoUi.zoom * 100)}%</span>
                            <input
                              type="range"
                              min="100"
                              max={PHOTO_MAX_ZOOM * 100}
                              step="5"
                              value={Math.round(photoUi.zoom * 100)}
                              disabled={!photoUi.ready}
                              onChange={(event: ChangeEvent<HTMLInputElement>) => previewPhotoZoom(Number(event.target.value) / 100)}
                              onPointerUp={commitPhotoZoom}
                              onKeyUp={commitPhotoZoom}
                              onBlur={commitPhotoZoom}
                              className="w-full accent-[#DC2626] disabled:opacity-50"
                            />
                          </label>
                          <button type="button" onClick={resetPhotoView} disabled={!photoUi.ready} className="w-full rounded-xl border border-[#D9C7A5] bg-white py-2 text-xs font-bold text-[#785B32] hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-50">
                            <T>ছবি আগের অবস্থায় আনুন</T>
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeSelectedBackground()}
                            disabled={!!cutoutBusy || photoUi.cutout}
                            className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#DC2626] py-2.5 text-xs font-extrabold text-white hover:bg-[#B91C1C] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {cutoutBusy ? <LoaderCircle size={15} className="animate-spin" /> : photoUi.cutout ? <Check size={15} /> : <Scissors size={15} />}
                            {photoUi.cutout ? <T>ব্যাকগ্রাউন্ড মুছে গেছে</T> : <T>ব্যাকগ্রাউন্ড মুছুন</T>}
                          </button>
                          {cutoutBusy ? (
                            <p className="text-[11px] leading-4 text-[#7A6A4C]">
                              {cutoutBusy.stage === "download"
                                ? <T>AI মডেল প্রস্তুত হচ্ছে (শুধু প্রথমবার একটু সময় লাগে)…</T>
                                : cutoutBusy.stage === "process"
                                  ? <T>ব্যাকগ্রাউন্ড মোছা হচ্ছে, একটু অপেক্ষা করুন…</T>
                                  : <T>ছবির কিনারা পরিষ্কার করা হচ্ছে…</T>}
                              {cutoutBusy.stage === "download" && cutoutBusy.percent !== null ? ` ${cutoutBusy.percent}%` : ""}
                            </p>
                          ) : null}
                          {photoUi.cutout && !cutoutBusy ? <p className="text-[11px] leading-4 text-[#7A6A4C]"><T>ভুল হলে ওপরের Undo চাপলে আগের ছবি ফিরে আসবে।</T></p> : null}
                          {cutoutError ? <p className="text-[11px] leading-4 font-semibold text-red-600">{cutoutError}</p> : null}
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

