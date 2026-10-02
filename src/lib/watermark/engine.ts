/**
 * Openmukti Gemini Watermark Remover — Core Engine
 *
 * Faithful re-implementation of the reverse-alpha un-blending technique used by
 * open-source Gemini watermark removers (originally by Ishara Madu), repackaged
 * clean: no ad redirects, no promo banners, no external calls.
 *
 * How it works:
 *  - `bg96.png` is a 96x96 capture of the Gemini sparkle watermark rendered on a
 *    white background. Since the watermark is pure white, max(r,g,b)/255 encodes
 *    the watermark's alpha channel.
 *  - Given a blended pixel:  blended = alpha * 255 + (1 - alpha) * original
 *    we recover:             original = (blended - alpha * 255) / (1 - alpha)
 *  - `gain` (Strength) scales the estimated alpha to compensate for compression
 *    artifacts; size scale / position offsets align the template onto the mark.
 *
 * Improvements over the original:
 *  - Position X/Y and Size Scale accept sub-pixel (float, 0.001-precision) values.
 *    The alpha template is drawn directly into the ROI with fractional geometry,
 *    so typed values like -127.525 genuinely shift the reconstruction.
 *  - 100% client-side, zero network requests.
 */

export const ALPHA_THRESHOLD = 0.002;
export const MAX_ALPHA = 0.99;
const LOGO_VALUE = 255;

export interface WmRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CleanerSettings {
  gain: number;
  offsetX: number;
  offsetY: number;
  sizeScale: number;
}

export interface DetectedWatermark {
  matchFound: boolean;
  score: number;
  presetKey: 'new' | 'classic';
  name: string;
  offsetX: number;
  offsetY: number;
  sizeScale: number;
  gain: number;
}

export const IMG_PRESETS: Record<'new' | 'classic', CleanerSettings> = {
  new: { gain: 0.6, offsetX: -128, offsetY: -128, sizeScale: 1 },
  classic: { gain: 1, offsetX: 0, offsetY: 0, sizeScale: 1 },
};

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Default watermark geometry for a given image size (Gemini sparkle, bottom-right). */
export function getWatermarkInfo(width: number, height: number): WmRect {
  const minDim = Math.min(width, height);
  const ratio = minDim / 1536;
  const size = Math.max(16, Math.round(96 * ratio));
  const margin = Math.max(8, Math.round(64 * ratio));

  return {
    size,
    x: Math.max(0, width - margin - size),
    y: Math.max(0, height - margin - size),
    width: size,
    height: size,
  } as WmRect & { size: number };
}

/** Resolve the user-tuned watermark box (float geometry, sub-pixel capable). */
export function resolveBox(
  base: WmRect & { size: number },
  width: number,
  height: number,
  opts: CleanerSettings,
): WmRect {
  const sizeScale = Number.isFinite(opts.sizeScale) && opts.sizeScale > 0 ? opts.sizeScale : 1;
  const size = clamp(base.size * sizeScale, 8, Math.min(width, height));
  const x = clamp(base.x + (opts.offsetX || 0), 0, width - size);
  const y = clamp(base.y + (opts.offsetY || 0), 0, height - size);
  return { x, y, width: size, height: size };
}

/** Region of interest around the watermark box (60% padding, integer bounds). */
export function getRoi(width: number, height: number, wm: WmRect): WmRect {
  const pad = Math.round(wm.width * 0.6);
  const x0 = Math.max(0, Math.floor(wm.x - pad));
  const y0 = Math.max(0, Math.floor(wm.y - pad));
  const x1 = Math.min(width, Math.ceil(wm.x + wm.width + pad));
  const y1 = Math.min(height, Math.ceil(wm.y + wm.height + pad));
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
}

/**
 * Build the ROI alpha map by drawing the reference watermark straight into an
 * ROI-sized canvas at fractional position/size (sub-pixel accurate).
 */
export function buildAlpha(
  bgImg: CanvasImageSource,
  roi: WmRect,
  wm: WmRect,
  gain: number,
): Float32Array {
  const count = roi.width * roi.height;
  const alphaMap = new Float32Array(count);

  const c = document.createElement('canvas');
  c.width = roi.width;
  c.height = roi.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  if (!cx) return alphaMap;

  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bgImg, wm.x - roi.x, wm.y - roi.y, wm.width, wm.height);
  const data = cx.getImageData(0, 0, roi.width, roi.height).data;

  const g = Number.isFinite(gain) && gain > 0 ? gain : 1;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const a = (Math.max(data[o], data[o + 1], data[o + 2]) / 255) * g;
    alphaMap[i] = a > ALPHA_THRESHOLD ? Math.min(a, MAX_ALPHA) : 0;
  }
  return alphaMap;
}

/** Reverse-alpha un-blend of the ROI pixels in-place. */
export function removeWatermark(
  imageData: ImageData,
  alphaMap: Float32Array,
  position: WmRect,
): void {
  const { x, y, width, height } = position;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const imgIdx = ((y + row) * imageData.width + (x + col)) * 4;
      const alphaIdx = row * width + col;

      const alpha = alphaMap[alphaIdx];
      if (alpha < ALPHA_THRESHOLD) continue;

      for (let c = 0; c < 3; c++) {
        const watermarked = imageData.data[imgIdx + c];
        const original = (watermarked - alpha * LOGO_VALUE) / (1.0 - alpha);
        imageData.data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
      }
    }
  }
}

/** Full clean pipeline for one frame. Returns the boxes used (for overlays). */
export function cleanFrame(
  bgImg: CanvasImageSource,
  imageData: ImageData,
  width: number,
  height: number,
  base: WmRect & { size: number },
  opts: CleanerSettings,
): { wm: WmRect; roi: WmRect } {
  const wm = resolveBox(base, width, height, opts);
  const roi = getRoi(width, height, wm);
  const alpha = buildAlpha(bgImg, roi, wm, opts.gain);
  removeWatermark(imageData, alpha, {
    x: roi.x,
    y: roi.y,
    width: roi.width,
    height: roi.height,
  });
  return { wm, roi };
}

/** Adaptive defaults for the two model presets. */
export function getAdaptiveImagePreset(
  presetKey: 'new' | 'classic',
  width = 1536,
  height = 1536,
): CleanerSettings {
  if (presetKey === 'classic') {
    return { gain: 1.0, offsetX: 0, offsetY: 0, sizeScale: 1.0 };
  }
  const minDim = Math.min(width, height || width);
  const scaleRatio = Math.max(0.25, Math.min(1.5, minDim / 1536));
  const adaptiveOffset = Math.round(-128 * scaleRatio);
  return {
    gain: 0.6,
    offsetX: adaptiveOffset,
    offsetY: adaptiveOffset,
    sizeScale: 1.0,
  };
}

// ── Auto-Detection (fused multi-scale, gradient & dual-polarity NCC) ──

interface AlphaTemplate {
  alphas: Float32Array;
  gradMag: Float32Array;
  size: number;
}

const alphaTemplateCache = new Map<number, AlphaTemplate>();

function getAlphaTemplateData(bgImg: CanvasImageSource, size: number): AlphaTemplate {
  const cached = alphaTemplateCache.get(size);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const cx = c.getContext('2d', { willReadFrequently: true });
  const alphas = new Float32Array(size * size);
  const gradMag = new Float32Array(size * size);
  if (!cx) {
    const template = { alphas, gradMag, size };
    alphaTemplateCache.set(size, template);
    return template;
  }

  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bgImg, 0, 0, size, size);
  const raw = cx.getImageData(0, 0, size, size).data;

  for (let i = 0; i < alphas.length; i++) {
    const o = i * 4;
    alphas[i] = Math.max(raw[o], raw[o + 1], raw[o + 2]) / 255.0;
  }

  for (let r = 1; r < size - 1; r++) {
    for (let col = 1; col < size - 1; col++) {
      const idx = r * size + col;
      const gx = alphas[idx + 1] - alphas[idx - 1];
      const gy = alphas[(r + 1) * size + col] - alphas[(r - 1) * size + col];
      gradMag[idx] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  const template = { alphas, gradMag, size };
  alphaTemplateCache.set(size, template);
  return template;
}

function evaluateCandidateMatch(
  imageData: ImageData,
  width: number,
  height: number,
  bgImg: CanvasImageSource,
  box: { x: number; y: number; size: number },
): { score: number; variance: number } {
  const { x, y, size } = box;
  if (x < 0 || y < 0 || x + size > width || y + size > height || size <= 0) {
    return { score: -1, variance: 0 };
  }

  const template = getAlphaTemplateData(bgImg, size);
  const { alphas, gradMag } = template;

  let sumL = 0, sumA = 0;
  let sumL2 = 0, sumA2 = 0;
  let sumLA = 0;

  let sumInvL = 0;
  let sumInvL2 = 0;
  let sumInvLA = 0;

  let sumG = 0, sumGA = 0;
  let sumG2 = 0, sumGA2 = 0;
  let sumGGA = 0;

  let n = 0;
  let nGrad = 0;

  const step = size > 80 ? 2 : 1;

  for (let r = 0; r < size; r += step) {
    const imgRow = y + r;
    for (let col = 0; col < size; col += step) {
      const imgCol = x + col;
      const imgIdx = (imgRow * width + imgCol) * 4;
      const alphaIdx = r * size + col;

      const rVal = imageData.data[imgIdx];
      const gVal = imageData.data[imgIdx + 1];
      const bVal = imageData.data[imgIdx + 2];
      const lum = 0.299 * rVal + 0.587 * gVal + 0.114 * bVal;
      const invLum = 255.0 - lum;
      const alpha = alphas[alphaIdx];

      sumL += lum;
      sumA += alpha;
      sumL2 += lum * lum;
      sumA2 += alpha * alpha;
      sumLA += lum * alpha;

      sumInvL += invLum;
      sumInvL2 += invLum * invLum;
      sumInvLA += invLum * alpha;
      n++;

      // Gradient analysis (high-frequency diamond sparkle edges)
      if (
        r > 0 && r < size - 1 && col > 0 && col < size - 1 &&
        imgRow > 0 && imgRow < height - 1 && imgCol > 0 && imgCol < width - 1
      ) {
        const leftIdx = (imgRow * width + (imgCol - 1)) * 4;
        const rightIdx = (imgRow * width + (imgCol + 1)) * 4;
        const upIdx = ((imgRow - 1) * width + imgCol) * 4;
        const downIdx = ((imgRow + 1) * width + imgCol) * 4;

        const lumLeft = 0.299 * imageData.data[leftIdx] + 0.587 * imageData.data[leftIdx + 1] + 0.114 * imageData.data[leftIdx + 2];
        const lumRight = 0.299 * imageData.data[rightIdx] + 0.587 * imageData.data[rightIdx + 1] + 0.114 * imageData.data[rightIdx + 2];
        const lumUp = 0.299 * imageData.data[upIdx] + 0.587 * imageData.data[upIdx + 1] + 0.114 * imageData.data[upIdx + 2];
        const lumDown = 0.299 * imageData.data[downIdx] + 0.587 * imageData.data[downIdx + 1] + 0.114 * imageData.data[downIdx + 2];

        const gx = lumRight - lumLeft;
        const gy = lumDown - lumUp;
        const imgGrad = Math.sqrt(gx * gx + gy * gy);
        const aGrad = gradMag[alphaIdx];

        sumG += imgGrad;
        sumGA += aGrad;
        sumG2 += imgGrad * imgGrad;
        sumGA2 += aGrad * aGrad;
        sumGGA += imgGrad * aGrad;
        nGrad++;
      }
    }
  }

  if (n === 0) return { score: -1, variance: 0 };

  const meanL = sumL / n;
  const meanA = sumA / n;
  const varL = Math.max(0, sumL2 / n - meanL * meanL);
  const varA = Math.max(0, sumA2 / n - meanA * meanA);

  if (varA <= 0.0001) {
    return { score: 0, variance: varL };
  }

  // White polarity NCC
  let nccWhite = 0;
  if (varL > 0.5) {
    const covLA = sumLA / n - meanL * meanA;
    nccWhite = covLA / Math.sqrt(varL * varA);
  }

  // Dark polarity NCC (for bright white backgrounds)
  let nccDark = 0;
  const meanInvL = sumInvL / n;
  const varInvL = Math.max(0, sumInvL2 / n - meanInvL * meanInvL);
  if (varInvL > 0.5 && meanL > 160) {
    const covInvLA = sumInvLA / n - meanInvL * meanA;
    nccDark = covInvLA / Math.sqrt(varInvL * varA);
  }

  const nccLum = Math.max(nccWhite, nccDark);

  // Gradient edge NCC
  let nccGrad = 0;
  if (nGrad > 10) {
    const meanG = sumG / nGrad;
    const meanGA = sumGA / nGrad;
    const varG = Math.max(0, sumG2 / nGrad - meanG * meanG);
    const varGA = Math.max(0, sumGA2 / nGrad - meanGA * meanGA);
    if (varG > 0.5 && varGA > 0.0001) {
      const covGGA = sumGGA / nGrad - meanG * meanGA;
      nccGrad = Math.max(0, covGGA / Math.sqrt(varG * varGA));
    }
  }

  let fusedScore = nccLum * 0.65 + nccGrad * 0.35;
  if (varL < 20) {
    fusedScore = Math.max(fusedScore, nccLum * 0.4 + nccGrad * 0.6);
  }

  return { score: Math.max(0, fusedScore), variance: varL };
}

interface LayoutFamily {
  presetKey: 'new' | 'classic';
  name: string;
  baseSize: number;
  calcPos: (s: number) => { x: number; y: number };
  gain: number;
  prior: number;
}

export function detectWatermarkCandidate(
  imageData: ImageData,
  width: number,
  height: number,
  bgImg: CanvasImageSource,
): DetectedWatermark {
  const minDim = Math.min(width, height);
  const baseRatio = minDim / 1536;
  const base = getWatermarkInfo(width, height) as WmRect & { size: number };

  // Candidate layout families with Bayesian priors
  const layoutFamilies: LayoutFamily[] = [
    // 1. Gemini & Nano Banana adaptive inset (12.5% inset)
    {
      presetKey: 'new',
      name: 'Gemini & Nano Banana (Adaptive)',
      baseSize: base.size,
      calcPos: (s) => {
        const m = Math.max(8, Math.round(192 * baseRatio));
        return { x: Math.max(0, width - m - s), y: Math.max(0, height - m - s) };
      },
      gain: 0.6,
      prior: 1.08,
    },
    // 2. Classic corner adaptive (4.16% margin)
    {
      presetKey: 'classic',
      name: 'Classic Corner (Adaptive)',
      baseSize: base.size,
      calcPos: (s) => {
        const m = Math.max(8, Math.round(64 * baseRatio));
        return { x: Math.max(0, width - m - s), y: Math.max(0, height - m - s) };
      },
      gain: 1.0,
      prior: 1.04,
    },
    // 3. Fixed standard (96px watermark regardless of crop/resize)
    {
      presetKey: 'new',
      name: 'Gemini & Nano Banana (Fixed 96px Inset)',
      baseSize: 96,
      calcPos: (s) => {
        const m = minDim >= 1400 ? 192 : Math.round(128 * Math.max(0.5, minDim / 1024));
        return { x: Math.max(0, width - m - s), y: Math.max(0, height - m - s) };
      },
      gain: 0.6,
      prior: 1.02,
    },
    // 4. Fixed 96px classic corner
    {
      presetKey: 'classic',
      name: 'Classic Corner (Fixed 96px)',
      baseSize: 96,
      calcPos: (s) => {
        const m = minDim >= 1024 ? 64 : 32;
        return { x: Math.max(0, width - m - s), y: Math.max(0, height - m - s) };
      },
      gain: 1.0,
      prior: 1.01,
    },
  ];

  // Multi-scale search pyramid
  const scalePyramid = [0.55, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.7];

  let bestMatch: {
    layout: LayoutFamily;
    size: number;
    x: number;
    y: number;
    score: number;
  } | null = null;
  let bestScore = -1;

  for (const layout of layoutFamilies) {
    for (const scale of scalePyramid) {
      const s = Math.max(16, Math.min(Math.round(layout.baseSize * scale), Math.min(width, height) - 8));
      const pos = layout.calcPos(s);
      const { score } = evaluateCandidateMatch(imageData, width, height, bgImg, {
        x: pos.x,
        y: pos.y,
        size: s,
      });
      const weightedScore = score * (layout.prior || 1.0);

      if (weightedScore > bestScore) {
        bestScore = weightedScore;
        bestMatch = { layout, size: s, x: pos.x, y: pos.y, score: weightedScore };
      }
    }
  }

  // Refinement: joint 2D position (±16px) and scale fine-tuning (±10%)
  if (bestMatch && bestMatch.score > 0.05) {
    let refinedX = bestMatch.x;
    let refinedY = bestMatch.y;
    let refinedSize = bestMatch.size;
    let refinedScore = bestMatch.score;

    const fineSizes = [
      Math.max(16, Math.round(bestMatch.size * 0.9)),
      Math.max(16, Math.round(bestMatch.size * 0.95)),
      bestMatch.size,
      Math.min(Math.min(width, height) - 8, Math.round(bestMatch.size * 1.05)),
      Math.min(Math.min(width, height) - 8, Math.round(bestMatch.size * 1.1)),
    ];
    const uniqueSizes = [...new Set(fineSizes)];

    for (const testSize of uniqueSizes) {
      for (let dy = -16; dy <= 16; dy += 4) {
        for (let dx = -16; dx <= 16; dx += 4) {
          const testX = Math.max(0, Math.min(width - testSize, bestMatch.x + dx));
          const testY = Math.max(0, Math.min(height - testSize, bestMatch.y + dy));
          const { score } = evaluateCandidateMatch(imageData, width, height, bgImg, {
            x: testX,
            y: testY,
            size: testSize,
          });
          const weightedScore = score * (bestMatch.layout.prior || 1.0);

          if (weightedScore > refinedScore) {
            refinedScore = weightedScore;
            refinedX = testX;
            refinedY = testY;
            refinedSize = testSize;
          }
        }
      }
    }

    const calculatedScale = Math.round((refinedSize / base.size) * 100) / 100;

    return {
      matchFound: refinedScore >= 0.1,
      score: Math.min(1.0, refinedScore),
      presetKey: bestMatch.layout.presetKey,
      name: `${bestMatch.layout.name} (${refinedSize}px)`,
      offsetX: refinedX - base.x,
      offsetY: refinedY - base.y,
      sizeScale: Math.max(0.5, Math.min(2.5, calculatedScale)),
      gain: bestMatch.layout.gain || 0.6,
    };
  }

  const fallbackOffset = Math.round(-128 * baseRatio);
  return {
    matchFound: false,
    score: bestScore > 0 ? bestScore : 0,
    presetKey: 'new',
    name: 'Gemini & Nano Banana (Adaptive)',
    offsetX: fallbackOffset,
    offsetY: fallbackOffset,
    sizeScale: 1.0,
    gain: 0.6,
  };
}

/** Loads the two reference watermark captures (same-origin static assets). */
export async function loadReferenceImages(): Promise<{ bg48: HTMLImageElement; bg96: HTMLImageElement }> {
  const loadImage = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = src;
    });

  const [bg48, bg96] = await Promise.all([loadImage('/wm/bg48.png'), loadImage('/wm/bg96.png')]);
  return { bg48, bg96 };
}

/** Decode a File into full-resolution ImageData (EXIF-orientation aware). */
export async function grabImageFrame(file: File): Promise<{
  width: number;
  height: number;
  imageData: ImageData;
}> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const width = bmp.width;
      const height = bmp.height;
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const cx = c.getContext('2d', { willReadFrequently: true });
      if (!cx) throw new Error('Canvas 2D unavailable');
      cx.drawImage(bmp, 0, 0, width, height);
      const imageData = cx.getImageData(0, 0, width, height);
      bmp.close();
      return { width, height, imageData };
    } catch {
      // fall through to Image element path
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      if (!cx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas 2D unavailable'));
        return;
      }
      cx.drawImage(img, 0, 0, w, h);
      const imageData = cx.getImageData(0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve({ width: w, height: h, imageData });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image file.'));
    };
    img.src = url;
  });
}
