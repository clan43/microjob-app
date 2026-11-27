// Browser-only background removal for photos placed in the Print Media editor.
// Same engine and edge clean-up as the "Remove Background" tool, so results match.
// The helper block below is copied from that tool on purpose; the tool itself is untouched.

// Photos bigger than this are scaled down before the AI runs: the model works
// at ~1024 px anyway, and huge images can run low-end phones out of memory.
const MAX_INPUT_SIDE = 2400;

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not create the download file.")),
      type,
      quality,
    );
  });
}

async function prepareInput(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // let the AI library report a proper error
  }
  const longSide = Math.max(bitmap.width, bitmap.height);
  if (longSide <= MAX_INPUT_SIDE) {
    bitmap.close();
    return file;
  }
  const scale = MAX_INPUT_SIDE / longSide;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return file;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Keep transparency for PNG/WebP inputs (logos); JPEG stays JPEG.
  return file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)
    ? canvasToBlob(canvas, "image/jpeg", 0.95)
    : canvasToBlob(canvas, "image/png");
}

const ALPHA_CUT_LOW = 12;
const ALPHA_CUT_HIGH = 240;
const MAX_FILL_LEVEL = 6; // clean colour is searched up to 2^6 = 64 px away
const GREEN_DOMINANCE = 10; // g - max(r, b) above this = green spill
const GREEN_SUBJECT_LIMIT = 0.04; // skip despill when the subject itself is green

type ColorLevel = {
  w: number;
  h: number;
  weight: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
};

function createLevel(w: number, h: number): ColorLevel {
  const size = w * h;
  return {
    w,
    h,
    weight: new Float32Array(size),
    r: new Float32Array(size),
    g: new Float32Array(size),
    b: new Float32Array(size),
  };
}

/** Colour sums built only from fully opaque pixels. Level k has cells of 2^(k+1) px. */
function buildSolidPyramid(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  include?: Uint8Array,
) {
  const levels: ColorLevel[] = [];
  const first = createLevel((w + 1) >> 1, (h + 1) >> 1);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (data[i * 4 + 3] !== 255) continue;
      if (include && !include[i]) continue;
      const j = (y >> 1) * first.w + (x >> 1);
      first.weight[j] += 1;
      first.r[j] += data[i * 4];
      first.g[j] += data[i * 4 + 1];
      first.b[j] += data[i * 4 + 2];
    }
  }
  levels.push(first);
  while (levels.length < MAX_FILL_LEVEL) {
    const prev = levels[levels.length - 1];
    const next = createLevel((prev.w + 1) >> 1, (prev.h + 1) >> 1);
    for (let y = 0; y < prev.h; y += 1) {
      for (let x = 0; x < prev.w; x += 1) {
        const i = y * prev.w + x;
        if (prev.weight[i] === 0) continue;
        const j = (y >> 1) * next.w + (x >> 1);
        next.weight[j] += prev.weight[i];
        next.r[j] += prev.r[i];
        next.g[j] += prev.g[i];
        next.b[j] += prev.b[i];
      }
    }
    levels.push(next);
  }
  return levels;
}

/** Smooth colour of the clean subject interior around (x, y), or null. */
function sampleInterior(
  levels: ColorLevel[],
  x: number,
  y: number,
): [number, number, number] | null {
  const order = [2, 3, 4, 5, 1, 0];
  for (const k of order) {
    const level = levels[k];
    if (!level) continue;
    const size = 1 << (k + 1);
    const fx = (x + 0.5) / size - 0.5;
    const fy = (y + 0.5) / size - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    let sw = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const cx = x0 + dx;
        const cy = y0 + dy;
        if (cx < 0 || cy < 0 || cx >= level.w || cy >= level.h) continue;
        const j = cy * level.w + cx;
        const n = level.weight[j];
        if (n <= 0) continue;
        const bw = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        sw += bw;
        sr += (level.r[j] / n) * bw;
        sg += (level.g[j] / n) * bw;
        sb += (level.b[j] / n) * bw;
      }
    }
    if (sw > 0) return [sr / sw, sg / sw, sb / sw];
  }
  return null;
}

/**
 * Cleans the colour fringe of an AI cut-out (RGBA):
 *  - green background that leaked into hair / edges is neutralised,
 *  - every partly transparent edge pixel takes the colour of the nearest clean
 *    foreground pixels, so it blends correctly over any new background,
 *  - faint ghosting and stray specks are removed.
 */
function cleanCutoutEdges(image: ImageData): void {
  const { width: w, height: h, data } = image;
  const total = w * h;

  // 1. Alpha curve: drop faint ghosting, make "almost solid" truly solid.
  for (let i = 0; i < total; i += 1) {
    const k = i * 4 + 3;
    const a = data[k];
    if (a <= ALPHA_CUT_LOW) data[k] = 0;
    else if (a >= ALPHA_CUT_HIGH) data[k] = 255;
    else
      data[k] = Math.round(
        ((a - ALPHA_CUT_LOW) * 255) / (ALPHA_CUT_HIGH - ALPHA_CUT_LOW),
      );
  }

  // 1b. Edge band. The old background colour bleeds several pixels into hair
  //     edges. `bandDistance` = distance (px) from fully transparent space,
  //     up to `bandMax`. The outer `rim` px are made gradually softer (step 3
  //     repaints them with clean colour from deeper inside), and in the whole
  //     band bright background-coloured patches are pulled back to the hair
  //     colour (1c).
  const rim = Math.min(7, Math.max(3, Math.round(Math.max(w, h) / 320)));
  const bandMax = Math.min(18, Math.max(8, Math.round(Math.max(w, h) / 120)));
  const dilate = (src: Uint8Array): Uint8Array => {
    const horizontal = new Uint8Array(total);
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        horizontal[row + x] =
          src[row + x] ||
          (x > 0 && src[row + x - 1]) ||
          (x < w - 1 && src[row + x + 1])
            ? 1
            : 0;
      }
    }
    const out = new Uint8Array(total);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        out[i] =
          horizontal[i] ||
          (y > 0 && horizontal[i - w]) ||
          (y < h - 1 && horizontal[i + w])
            ? 1
            : 0;
      }
    }
    return out;
  };
  const bandDistance = new Uint8Array(total); // 0 = outside the band
  {
    let reached: Uint8Array = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) {
      if (data[i * 4 + 3] === 0) reached[i] = 1;
    }
    for (let d = 1; d <= bandMax; d += 1) {
      const next = dilate(reached);
      for (let i = 0; i < total; i += 1) {
        if (next[i] && !reached[i]) bandDistance[i] = d;
      }
      reached = next;
    }
  }

  // 1c. Pull bright background-coloured patches in the band back to the
  //     colour of the clean interior (only pixels clearly brighter than their
  //     surroundings are changed, so real light edges stay untouched).
  {
    const deep = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) {
      if (data[i * 4 + 3] === 255 && bandDistance[i] === 0) deep[i] = 1;
    }
    const deepLevels = buildSolidPyramid(data, w, h, deep);
    const LUM_MARGIN = 26;
    const LUM_RAMP = 44;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (bandDistance[i] === 0 || data[i * 4 + 3] !== 255) continue;
        const ref = sampleInterior(deepLevels, x, y);
        if (!ref) continue;
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const refLum = 0.299 * ref[0] + 0.587 * ref[1] + 0.114 * ref[2];
        const t = Math.min(1, Math.max(0, (lum - refLum - LUM_MARGIN) / LUM_RAMP));
        if (t <= 0) continue;
        data[i * 4] = Math.round(r * (1 - t) + ref[0] * t);
        data[i * 4 + 1] = Math.round(g * (1 - t) + ref[1] * t);
        data[i * 4 + 2] = Math.round(b * (1 - t) + ref[2] * t);
      }
    }
  }

  // 1d. Soften the outer rim; step 3 repaints these pixels.
  for (let i = 0; i < total; i += 1) {
    const d = bandDistance[i];
    if (d === 0 || d > rim) continue;
    const k = i * 4 + 3;
    data[k] = Math.round((data[k] * d) / (rim + 1));
  }

  // 2. Green despill on the edge band of the subject.
  //    "Deep" = inside a cell that is completely opaque; the band is everything
  //    opaque that is not deep. Skipped when the subject itself is green.
  let levels = buildSolidPyramid(data, w, h);
  const bandIndex = Math.max(w, h) > 3000 ? 4 : 3; // 32 px / 16 px cells
  const band = levels[bandIndex];
  const cell = 2 << bandIndex;
  const isDeepCell = (cx: number, cy: number) => {
    const cw = Math.min(cell, w - cx * cell);
    const ch = Math.min(cell, h - cy * cell);
    return band.weight[cy * band.w + cx] >= cw * ch;
  };
  let deepPixels = 0;
  let deepGreen = 0;
  for (let cy = 0; cy < band.h; cy += 1) {
    for (let cx = 0; cx < band.w; cx += 1) {
      if (!isDeepCell(cx, cy)) continue;
      const j = cy * band.w + cx;
      const n = band.weight[j];
      deepPixels += n;
      const r = band.r[j] / n;
      const g = band.g[j] / n;
      const b = band.b[j] / n;
      if (g - Math.max(r, b) > GREEN_DOMINANCE) deepGreen += n;
    }
  }
  if (deepPixels > 0 && deepGreen / deepPixels < GREEN_SUBJECT_LIMIT) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (data[i * 4 + 3] !== 255) continue;
        if (isDeepCell((x / cell) | 0, (y / cell) | 0)) continue;
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const over = g - Math.max(r, b);
        if (over > GREEN_DOMINANCE) {
          data[i * 4 + 1] = Math.round(Math.max(r, b) + over * 0.1);
        }
      }
    }
    levels = buildSolidPyramid(data, w, h); // rebuild with the cleaned colours
  }

  // 3. Recolour every partly transparent pixel from nearby clean foreground
  //    colour (bilinear between cells, so there is no blockiness).
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const a = data[i * 4 + 3];
      if (a === 0 || a === 255) continue;
      let filled = false;
      for (let k = 0; k < levels.length; k += 1) {
        const level = levels[k];
        const shift = k + 1;
        const size = 1 << shift;
        const fx = (x + 0.5) / size - 0.5;
        const fy = (y + 0.5) / size - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        let sw = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const cx = x0 + dx;
            const cy = y0 + dy;
            if (cx < 0 || cy < 0 || cx >= level.w || cy >= level.h) continue;
            const j = cy * level.w + cx;
            const n = level.weight[j];
            if (n <= 0) continue;
            const bw = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
            sw += bw;
            sr += (level.r[j] / n) * bw;
            sg += (level.g[j] / n) * bw;
            sb += (level.b[j] / n) * bw;
          }
        }
        if (sw > 0) {
          data[i * 4] = Math.round(sr / sw);
          data[i * 4 + 1] = Math.round(sg / sw);
          data[i * 4 + 2] = Math.round(sb / sw);
          filled = true;
          break;
        }
      }
      // No clean foreground nearby: a stray speck, not part of the subject.
      if (!filled) data[i * 4 + 3] = 0;
    }
  }
}

async function cleanCutoutBlob(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    return blob;
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  cleanCutoutEdges(imageData);
  context.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas, "image/png");
}


// Optional self-hosted model files (same env var as the Remove Background tool).
const MODEL_PUBLIC_PATH = process.env.NEXT_PUBLIC_BG_REMOVAL_PUBLIC_PATH || undefined;

export type CutoutStage = "download" | "process" | "finish";

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);
  const mime = meta.split(";")[0] || "image/png";
  const raw = meta.includes("base64") ? atob(dataUrl.slice(comma + 1)) : decodeURIComponent(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the result.")));
    reader.onerror = () => reject(new Error("Could not read the result."));
    reader.readAsDataURL(blob);
  });
}

/** Takes a photo as a data URL and returns the same photo with a transparent background (PNG data URL). */
export async function removePhotoBackground(
  dataUrl: string,
  onProgress?: (stage: CutoutStage, percent: number | null) => void,
): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const file = new File([blob], "photo", { type: blob.type || "image/png" });
  const input = await prepareInput(file);
  onProgress?.("download", null);
  const { removeBackground } = await import("@imgly/background-removal");
  const downloads = new Map<string, { current: number; total: number }>();
  let highest = 0;
  const raw: Blob = await removeBackground(input, {
    ...(MODEL_PUBLIC_PATH ? { publicPath: MODEL_PUBLIC_PATH } : {}),
    output: { format: "image/png" },
    progress: (key: string, current: number, total: number) => {
      if (key.startsWith("compute")) {
        onProgress?.("process", null);
        return;
      }
      if (!(total > 0)) return;
      downloads.set(key, { current: Math.min(current, total), total });
      let sumCurrent = 0;
      let sumTotal = 0;
      downloads.forEach((asset) => {
        sumCurrent += asset.current;
        sumTotal += asset.total;
      });
      const overall = Math.min(100, Math.floor((sumCurrent / sumTotal) * 100));
      if (overall > highest) {
        highest = overall;
        onProgress?.("download", overall);
      }
    },
  } as Parameters<typeof removeBackground>[1]);
  onProgress?.("finish", null);
  let finalBlob = raw;
  try {
    finalBlob = await cleanCutoutBlob(raw);
  } catch (cleanError) {
    console.error("[Print Media] Edge clean-up skipped:", cleanError);
  }
  return blobToDataUrl(finalBlob);
}

export function friendlyCutoutError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/fetch|network|load failed|failed to load|cors|timed? ?out/i.test(message)) {
    return "AI মডেল ডাউনলোড করা যায়নি। ইন্টারনেট পরীক্ষা করে আবার চেষ্টা করুন।";
  }
  if (/memory|allocation|alloc/i.test(message)) {
    return "ছবিটি আপনার ফোন/কম্পিউটারের জন্য অনেক বড়। ছোট ছবি দিয়ে চেষ্টা করুন।";
  }
  return "ব্যাকগ্রাউন্ড মুছতে সমস্যা হয়েছে। আবার চেষ্টা করুন।";
}
