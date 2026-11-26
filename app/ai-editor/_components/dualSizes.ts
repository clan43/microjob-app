/**
 * Dual (two-person) photo sizes.
 *
 * Every size is the size of the WHOLE dual photo (both people together), so each
 * person gets exactly half of the width. The label always uses the "W×H mm" or
 * "W×H inch" format, which is what the rest of the AI editor already parses.
 */
export interface DualSizePreset {
  id: string;
  /** Parseable size label ("90×55 mm" / "3×2 inch"). */
  label: string;
  /** Short English note shown next to the size in the dropdown (translated through AiT/t). */
  note: string;
}

export const DEFAULT_DUAL_SIZE = "90×55 mm";

// Bangladesh: the common couple / two-person photo sizes.
// Passport 45×55, visa/stamp 35×45 and e-passport 25×30 each person, placed side by side.
export const DUAL_SIZE_PRESETS: DualSizePreset[] = [
  { id: "dual-90x55", label: "90×55 mm", note: "Passport ×2 (45×55 each)" },
  { id: "dual-70x45", label: "70×45 mm", note: "Visa / Stamp ×2 (35×45 each)" },
  { id: "dual-50x30", label: "50×30 mm", note: "E-Pass ×2 (25×30 each)" },
  { id: "dual-80x50", label: "80×50 mm", note: "40×50 ×2" },
  { id: "dual-4x2in", label: "4×2 inch", note: "2×2 inch ×2" },
  { id: "dual-3x2in", label: "3×2 inch", note: "Small couple photo" },
  { id: "dual-4x2.5in", label: "4×2.5 inch", note: "Couple photo" },
  { id: "dual-1.9x1.5in", label: "1.9×1.5 inch", note: "Small dual" },
];

export type DualUnit = "mm" | "cm" | "inch";

export const DUAL_CUSTOM_ID = "custom";

// Safe limits for a custom dual size (millimetres) so the browser canvas never runs out of memory.
export const DUAL_MIN_MM = 20;
export const DUAL_MAX_MM = 300;

const UNIT_TO_MM: Record<DualUnit, number> = { mm: 1, cm: 10, inch: 25.4 };

const trimNumber = (value: number) => String(Math.round(value * 100) / 100);

/** Builds a parseable size label from a custom width/height typed by the user. Returns null when invalid. */
export function buildCustomDualLabel(width: string, height: string, unit: DualUnit): string | null {
  const w = parseFloat(width);
  const h = parseFloat(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const wMm = w * UNIT_TO_MM[unit];
  const hMm = h * UNIT_TO_MM[unit];
  if (wMm < DUAL_MIN_MM || hMm < DUAL_MIN_MM || wMm > DUAL_MAX_MM || hMm > DUAL_MAX_MM) return null;
  // A dual photo is two people side by side, so it must be wider than it is tall.
  if (wMm < hMm * 1.05) return null;
  return unit === "inch" ? `${trimNumber(w)}×${trimNumber(h)} inch` : `${trimNumber(wMm)}×${trimNumber(hMm)} mm`;
}

/** Reads a "W×H mm" / "W×H inch" label into millimetres. Falls back to the default 90×55 mm. */
export function dualLabelToMm(label: string): { widthMm: number; heightMm: number } {
  const match = /(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*(mm|inch|in)\b/i.exec(String(label || ""));
  if (!match) return { widthMm: 90, heightMm: 55 };
  const factor = match[3].toLowerCase() === "mm" ? 1 : 25.4;
  return { widthMm: parseFloat(match[1]) * factor, heightMm: parseFloat(match[2]) * factor };
}

/** Label of ONE person's half of a dual photo (always in mm). */
export function dualHalfLabel(label: string): string {
  const { widthMm, heightMm } = dualLabelToMm(label);
  return `${trimNumber(widthMm / 2)}×${trimNumber(heightMm)} mm`;
}

export function isPresetDualLabel(label: string): boolean {
  return DUAL_SIZE_PRESETS.some((preset) => preset.label === label);
}
