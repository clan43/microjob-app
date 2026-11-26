/**
 * Passport-type photo sizes (single person).
 *
 * The first entry is the DEFAULT. Every label uses the "W×H mm" / "W×H inch" format that the
 * rest of the AI editor already parses (crop ratio, exact export pixels, print studio).
 *
 * Sources checked (Bangladesh): DIP / e-passport form guides, Bangladesh High Commission
 * documents and photo-spec sites. Official wording differs between sources and years, so the
 * user can always pick another preset or type a custom size.
 */
export interface PassportSizePreset {
  id: string;
  /** Parseable size label ("45×55 mm"). */
  label: string;
  /** Short English note shown next to the size in the dropdown (translated through AiT/t). */
  note: string;
}

export const DEFAULT_PASSPORT_SIZE = "45×55 mm";

export const PASSPORT_SIZE_PRESETS: PassportSizePreset[] = [
  { id: "passport-45x55", label: "45×55 mm", note: "Passport / MRP (default)" },
  { id: "passport-40x50", label: "40×50 mm", note: "College / job / form (4×5 cm)" },
  { id: "passport-35x45", label: "35×45 mm", note: "ICAO / embassy / foreign visa" },
  { id: "passport-25x30", label: "25×30 mm", note: "Online e-passport form / stamp" },
  { id: "passport-2x2in", label: "2×2 inch", note: "US visa / DV lottery" },
];

export type PassportUnit = "mm" | "cm" | "inch";

export const PASSPORT_CUSTOM_ID = "custom";

// Safe limits for a custom passport size (millimetres) so the browser canvas never runs out of memory.
export const PASSPORT_MIN_MM = 10;
export const PASSPORT_MAX_MM = 150;

const UNIT_TO_MM: Record<PassportUnit, number> = { mm: 1, cm: 10, inch: 25.4 };

const trimNumber = (value: number) => String(Math.round(value * 100) / 100);

/** Builds a parseable size label from a custom width/height typed by the user. Returns null when invalid. */
export function buildCustomPassportLabel(width: string, height: string, unit: PassportUnit): string | null {
  const w = parseFloat(width);
  const h = parseFloat(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const wMm = w * UNIT_TO_MM[unit];
  const hMm = h * UNIT_TO_MM[unit];
  if (wMm < PASSPORT_MIN_MM || hMm < PASSPORT_MIN_MM || wMm > PASSPORT_MAX_MM || hMm > PASSPORT_MAX_MM) return null;
  // Always saved in mm so the crop ratio and the exact export size are never mixed up by units.
  return `${trimNumber(wMm)}×${trimNumber(hMm)} mm`;
}

/** Reads a "W×H mm" / "W×H inch" label into millimetres. Falls back to the default 45×55 mm. */
export function passportLabelToMm(label: string): { widthMm: number; heightMm: number } {
  const match = /(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*(mm|inch|in)\b/i.exec(String(label || ""));
  if (!match) return { widthMm: 45, heightMm: 55 };
  const factor = match[3].toLowerCase() === "mm" ? 1 : 25.4;
  return { widthMm: parseFloat(match[1]) * factor, heightMm: parseFloat(match[2]) * factor };
}

export function isPresetPassportLabel(label: string): boolean {
  return PASSPORT_SIZE_PRESETS.some((preset) => preset.label === label);
}
