/**
 * Output helpers for Bulk Photo Edit.
 *
 * The AI edits the photos first. Afterwards the person can pick an exact output size
 * (Passport, Visa, admission portals...) and download / print the results at that size.
 * Everything here reuses the AI Editor's export code, so a photo comes out exactly the same
 * size and quality as it would from the AI Editor.
 */
import {
  addDpiMetadata,
  buildPrintStudioPayload,
  canvasToBlob,
  downloadBlob,
  downloadPhotosArchive,
  downloadPhotosPdf,
  loadImageElement,
  parsePhysicalSizeLabel,
  physicalToPixels,
  renderPhotoToExportCanvas,
  type ExportableImage,
} from "@/app/ai-editor/_components/photoExport";
import { ADMISSION_PRESETS, presetLabel, resolveExportFormat } from "@/app/ai-editor/_components/admissionSizes";

export type BulkSizeOption = {
  id: string;
  /** Short title on the chip / option. */
  label: string;
  /** Small second line (the real size). */
  hint: string;
  /** Size label understood by the AI Editor export code. Empty = keep the AI result as it is. */
  value: string;
};

export type BulkOutputFormat = "jpg" | "png";

export const ORIGINAL_SIZE_ID = "original";

export const BULK_SIZE_OPTIONS: BulkSizeOption[] = [
  { id: ORIGINAL_SIZE_ID, label: "Original size", hint: "Keep the AI result as it is", value: "" },
  { id: "passport", label: "Passport", hint: "45×55 mm", value: "45×55 mm" },
  { id: "e-pass", label: "E-Pass", hint: "25×30 mm", value: "25×30 mm" },
  { id: "visa", label: "Visa", hint: "35×45 mm", value: "35×45 mm" },
  { id: "birth", label: "Birth certificate", hint: "35×45 mm", value: "35×45 mm" },
];

/** University / job portal presets with exact pixels and KB limits (same list as the AI Editor). */
export const BULK_ADMISSION_OPTIONS: BulkSizeOption[] = ADMISSION_PRESETS.map((preset) => ({
  id: `admission-${preset.id}`,
  label: preset.title,
  hint: presetLabel(preset),
  value: presetLabel(preset),
}));

export const ALL_BULK_SIZE_OPTIONS: BulkSizeOption[] = [...BULK_SIZE_OPTIONS, ...BULK_ADMISSION_OPTIONS];

export function findSizeOption(id: string): BulkSizeOption {
  return ALL_BULK_SIZE_OPTIONS.find((option) => option.id === id) ?? BULK_SIZE_OPTIONS[0];
}

/**
 * Turns one AI result into something the AI Editor export code understands.
 * With a size chosen, the picture is first cropped to that shape (keeping a little head room),
 * so the final photo has no empty bars.
 */
export async function makeExportable(url: string, sizeValue: string): Promise<ExportableImage> {
  if (!sizeValue) return { url, size: "Original size", bgColor: "#FFFFFF" };

  const physical = parsePhysicalSizeLabel(sizeValue);
  const target = physicalToPixels(physical, 300);
  const img = await loadImageElement(url);
  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  if (!sourceWidth || !sourceHeight) throw new Error("Invalid image dimensions.");

  const targetRatio = target.widthPx / target.heightPx;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceWidth / sourceHeight > targetRatio) cropWidth = Math.max(1, Math.round(sourceHeight * targetRatio));
  else cropHeight = Math.max(1, Math.round(sourceWidth / targetRatio));
  const cropX = Math.round((sourceWidth - cropWidth) / 2);
  // Keep most of the extra height at the bottom so the head is never cut off.
  const cropY = Math.round((sourceHeight - cropHeight) * 0.2);

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not supported by this browser.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  const dataUrl = canvas.toDataURL("image/png");
  canvas.width = 0;
  canvas.height = 0;

  return {
    url: dataUrl,
    size: sizeValue,
    bgColor: "#FFFFFF",
    dpi: target.dpi,
    widthPx: target.widthPx,
    heightPx: target.heightPx,
  };
}

/** Downloads one photo at the chosen size (exact pixels, DPI and KB limit are handled for you). */
export async function downloadSizedPhoto(url: string, sizeValue: string, format: BulkOutputFormat, baseName: string) {
  const image = await makeExportable(url, sizeValue);
  const exported = await renderPhotoToExportCanvas(image);
  try {
    const fmt = resolveExportFormat(format, image.size);
    const raw = await canvasToBlob(exported.canvas, fmt, image.size);
    const blob = await addDpiMetadata(raw, fmt, exported.dpi);
    downloadBlob(blob, `${baseName}-${exported.widthPx}x${exported.heightPx}.${fmt}`);
  }
  finally {
    exported.canvas.width = 0;
    exported.canvas.height = 0;
  }
}

export async function downloadZip(urls: string[], sizeValue: string, format: BulkOutputFormat) {
  const images: ExportableImage[] = [];
  for (const url of urls) images.push(await makeExportable(url, sizeValue));
  await downloadPhotosArchive(images, format);
}

export async function downloadPdf(urls: string[], sizeValue: string) {
  const images: ExportableImage[] = [];
  for (const url of urls) images.push(await makeExportable(url, sizeValue));
  await downloadPhotosPdf(images);
}

export type BulkPrintSource = {
  image: string;
  sourceKey?: string;
  preset: { id?: string; label?: string; widthMm: number; heightMm: number };
};

/** Prepares the results for the Print Studio (the same one the AI Editor uses). */
export async function buildBulkPrintSources(items: Array<{ key: string; url: string }>, sizeValue: string): Promise<BulkPrintSource[]> {
  const sources: BulkPrintSource[] = [];
  for (const item of items) {
    const exportable = await makeExportable(item.url, sizeValue);
    const payload = await buildPrintStudioPayload(exportable);
    sources.push({ image: payload.dataUrl, sourceKey: item.key, preset: payload.preset });
  }
  return sources;
}
