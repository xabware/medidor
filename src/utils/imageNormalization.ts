/**
 * Image perspective-correction utilities.
 *
 * Given 4 corners of a rectangle visible in the photo, compute
 * a projective homography that warps the image so the rectangle
 * becomes axis-aligned. This corrects for camera perspective
 * (trapezoid → rectangle).
 */

import type { DrawingPoint } from '../types';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface NormalizationResult {
  dataUrl: string;
  width: number;
  height: number;
  /** Transform a point from the original image-space to the warped image-space */
  transformPoint: (p: DrawingPoint) => DrawingPoint;
  /** Pixels-per-real-unit in X after the warp */
  pixelsPerUnitX: number;
  /** Pixels-per-real-unit in Y after the warp */
  pixelsPerUnitY: number;
}

/* ------------------------------------------------------------------ */
/*  Linear algebra helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Solve an 8×8 linear system Ax = b using Gaussian elimination
 * with partial pivoting.
 */
function solveLinear8(A: number[][], b: number[]): number[] {
  const n = 8;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(aug[row][col]);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxVal < 1e-12) throw new Error('Sistema singular – las esquinas pueden ser colineales');
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / pivot;
      for (let j = col; j <= n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  // Back-substitution
  const x = new Array<number>(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = aug[row][n];
    for (let col = row + 1; col < n; col++) sum -= aug[row][col] * x[col];
    x[row] = sum / aug[row][row];
  }
  return x;
}

/**
 * Compute the 3×3 homography matrix H that maps
 * src[i] → dst[i] (in homogeneous coordinates: dst ~ H · src).
 *
 * Uses the DLT (Direct Linear Transform) with 4 correspondences.
 */
function computeHomography(
  src: [DrawingPoint, DrawingPoint, DrawingPoint, DrawingPoint],
  dst: [DrawingPoint, DrawingPoint, DrawingPoint, DrawingPoint],
): number[][] {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x: sx, y: sy } = src[i];
    const { x: dx, y: dy } = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }

  const h = solveLinear8(A, b);

  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

/** Invert a 3×3 matrix. */
function invert3(M: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error('Homografía singular');
  const inv = 1 / det;
  return [
    [(e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [(f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ];
}

/** Multiply two 3×3 matrices. */
function mul3(A: number[][], B: number[][]): number[][] {
  const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        R[i][j] += A[i][k] * B[k][j];
  return R;
}

/** Apply a 3×3 homography to a 2-D point (homogeneous division). */
function applyH(H: number[][], p: DrawingPoint): DrawingPoint {
  const w = H[2][0] * p.x + H[2][1] * p.y + H[2][2];
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: (H[0][0] * p.x + H[0][1] * p.y + H[0][2]) / w,
    y: (H[1][0] * p.x + H[1][1] * p.y + H[1][2]) / w,
  };
}

function ptDist(a: DrawingPoint, b: DrawingPoint): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/* ------------------------------------------------------------------ */
/*  Main public API                                                    */
/* ------------------------------------------------------------------ */

/**
 * Correct perspective distortion so the quadrilateral defined by
 * `corners` becomes a proper axis-aligned rectangle.
 *
 * @param imageDataUrl  Source image as a data-URL.
 * @param corners       The 4 corners of the known rectangle visible in
 *                       the photo, in order: [TL, TR, BR, BL].
 * @param realWidth     Real-world width  of the rectangle (in user units).
 * @param realHeight    Real-world height of the rectangle (in user units).
 */
export async function normalizeImage(
  imageDataUrl: string,
  corners: [DrawingPoint, DrawingPoint, DrawingPoint, DrawingPoint],
  realWidth: number,
  realHeight: number,
): Promise<NormalizationResult> {
  const srcImg = await loadImage(imageDataUrl);
  const srcW = srcImg.width;
  const srcH = srcImg.height;

  const [TL, TR, BR, BL] = corners;

  // Destination pixel dimensions — use the max of opposite edges
  // so we don't lose resolution.
  const dstW = Math.round(Math.max(ptDist(TL, TR), ptDist(BL, BR)));
  const dstH = Math.round(Math.max(ptDist(TL, BL), ptDist(TR, BR)));

  if (dstW < 2 || dstH < 2) {
    throw new Error('El rectángulo de referencia es demasiado pequeño');
  }

  // Destination corners for the reference rectangle (before offset).
  const dstRect: [DrawingPoint, DrawingPoint, DrawingPoint, DrawingPoint] = [
    { x: 0, y: 0 },        // TL'
    { x: dstW, y: 0 },     // TR'
    { x: dstW, y: dstH },  // BR'
    { x: 0, y: dstH },     // BL'
  ];

  // Forward homography: source → dest (maps the quad onto the rect).
  const H_fwd = computeHomography(corners, dstRect);

  // Find where the 4 image-border corners land in dest space.
  const imgCorners = [
    { x: 0, y: 0 },
    { x: srcW, y: 0 },
    { x: srcW, y: srcH },
    { x: 0, y: srcH },
  ];
  const mapped = imgCorners.map(c => applyH(H_fwd, c));

  // Bounding box (include both the reference rect and the mapped image frame).
  const allX = [...mapped.map(c => c.x), ...dstRect.map(c => c.x)];
  const allY = [...mapped.map(c => c.y), ...dstRect.map(c => c.y)];
  const minX = Math.floor(Math.min(...allX));
  const minY = Math.floor(Math.min(...allY));
  const maxX = Math.ceil(Math.max(...allX));
  const maxY = Math.ceil(Math.max(...allY));

  const outW = maxX - minX;
  const outH = maxY - minY;

  const MAX_DIM = 10000;
  if (outW < 1 || outH < 1 || outW > MAX_DIM || outH > MAX_DIM) {
    throw new Error(`Dimensiones resultantes fuera de rango: ${outW}×${outH}`);
  }

  // Shift homography so (minX, minY) becomes (0, 0) in the output.
  const T: number[][] = [[1, 0, -minX], [0, 1, -minY], [0, 0, 1]];
  const H_adj = mul3(T, H_fwd);           // source → output
  const H_inv = invert3(H_adj);           // output → source (for sampling)

  // ── Render the warped image via inverse mapping + bilinear sampling ──
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext('2d')!;
  srcCtx.drawImage(srcImg, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d')!;
  const outImgData = outCtx.createImageData(outW, outH);
  const outPx = outImgData.data;

  for (let dy = 0; dy < outH; dy++) {
    for (let dx = 0; dx < outW; dx++) {
      const sp = applyH(H_inv, { x: dx, y: dy });

      const x0 = Math.floor(sp.x);
      const y0 = Math.floor(sp.y);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= srcW || y0 + 1 >= srcH) continue;

      const fx = sp.x - x0;
      const fy = sp.y - y0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + srcW * 4;
      const i11 = i01 + 4;

      const idx = (dy * outW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        outPx[idx + c] = Math.round(
          srcData[i00 + c] * (1 - fx) * (1 - fy) +
          srcData[i10 + c] * fx * (1 - fy) +
          srcData[i01 + c] * (1 - fx) * fy +
          srcData[i11 + c] * fx * fy,
        );
      }
    }
  }

  outCtx.putImageData(outImgData, 0, 0);

  // ── Build the point-transform function (original → warped) ──
  const transformPoint = (p: DrawingPoint): DrawingPoint => applyH(H_adj, p);

  return {
    dataUrl: outCanvas.toDataURL('image/png'),
    width: outW,
    height: outH,
    transformPoint,
    pixelsPerUnitX: dstW / realWidth,
    pixelsPerUnitY: dstH / realHeight,
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
