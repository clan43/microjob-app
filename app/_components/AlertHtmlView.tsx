"use client";

import { useEffect, useRef } from "react";

/**
 * Shows admin-written alert HTML safely.
 *  - The HTML is parsed into an inert document and cleaned with an allow-list walk (no scripts,
 *    no event handlers, no javascript: links, no forms/iframes) before anything touches the page.
 *  - It is rendered in a Shadow DOM, so the admin's CSS can never restyle the site and the
 *    site's CSS can never break the admin's design.
 *  - Any element with a data-alert-close attribute closes the popup; links are reported through onLink.
 * The admin preview and the real popup use this same component, so they look identical.
 */

const BLOCKED = new Set([
  "SCRIPT", "IFRAME", "OBJECT", "EMBED", "FORM", "NOSCRIPT", "FRAME", "FRAMESET", "APPLET",
  "LINK", "BASE", "META", "INPUT", "TEXTAREA", "SELECT", "SET", "ANIMATE", "TEMPLATE",
]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "background"]);
const BAD_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|@import|behavior\s*:|-moz-binding|url\(\s*["']?\s*(?!https:|data:image\/|#)/i;

function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/[^{}]*\{[^{}]*(?:expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding)[^{}]*\}/gi, "")
    .replace(/url\(\s*["']?\s*(?!https:|data:image\/|#)[^)]*\)/gi, "none");
}

function cleanTree(root: ParentNode) {
  const all = Array.from(root.querySelectorAll("*"));
  for (const el of all) {
    if (BLOCKED.has(el.tagName.toUpperCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction") {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.has(name)) {
        const v = value.replace(/[\u0000-\u0020\u00a0]+/g, "").toLowerCase();
        const dataImage = name === "src" && v.startsWith("data:image/") && !v.startsWith("data:image/svg");
        if (/^(javascript|vbscript|data):/.test(v) && !dataImage) el.removeAttribute(attr.name);
      } else if (name === "style") {
        if (BAD_CSS.test(value)) el.removeAttribute(attr.name);
      }
    }
    if (el.tagName.toUpperCase() === "A") {
      const href = el.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  }
}

function toSafeMarkup(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles = Array.from(doc.querySelectorAll("style"))
    .map((s) => `<style>${cleanCss(s.textContent || "")}</style>`)
    .join("");
  doc.querySelectorAll("style").forEach((s) => s.remove());
  cleanTree(doc.body);
  return `${styles}${doc.body.innerHTML}`;
}

type Props = {
  html: string;
  onClose?: () => void;
  /** Called when the user clicks a link inside the alert (so the popup can count the click and close). */
  onLink?: () => void;
};

export default function AlertHtmlView({ html, onClose, onLink }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handlersRef = useRef({ onClose, onLink });
  handlersRef.current = { onClose, onLink };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block}*,*::before,*::after{box-sizing:border-box}img,svg,video{max-width:100%}</style>${toSafeMarkup(html)}`;

    const onClick = (event: Event) => {
      const target = event.target as Element | null;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest("[data-alert-close]")) {
        event.preventDefault();
        handlersRef.current.onClose?.();
        return;
      }
      const link = target.closest("a");
      if (link && link.getAttribute("href") && !link.getAttribute("href")!.startsWith("#")) {
        handlersRef.current.onLink?.();
      } else if (link) {
        event.preventDefault();
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [html]);

  return <div ref={hostRef} />;
}
