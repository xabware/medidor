/**
 * SAM model loading & embeddings computation.
 * Uses @huggingface/transformers with ONNX WASM proxy for non-blocking inference.
 */

import type { DrawingPoint, ROIRegion } from '../types';
import { isDebugEnabled, debugVisualizeSAM, getDebugROIImageUrl } from './samDebugVisualizer';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Enable ONNX WASM proxy (runs inference in a Web Worker)
let _proxyConfigured = false;
async function ensureWasmProxy() {
  if (_proxyConfigured) return;
  try {
    const { env } = await import('@huggingface/transformers');
    if (env?.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.proxy = true;
    }
  } catch { /* ignore – non-critical */ }
  _proxyConfigured = true;
}

// Module-level singletons
let model: any = null;
let processor: any = null;
let loadPromise: Promise<void> | null = null;
let loadedModelId: string | null = null;

// Cached dynamic imports (avoid re-importing on every call)
let _RawImage: any = null;
async function getRawImage() {
  if (!_RawImage) { const m = await import('@huggingface/transformers'); _RawImage = m.RawImage; }
  return _RawImage;
}

// Embeddings cache: "modelId::imageId" → SAMEmbeddings
const embeddingsCache = new Map<string, SAMEmbeddings>();

// Model catalogue
export interface SAMModelInfo {
  id: string;
  name: string;
  size: string;
  description: string;
  minRAM: number;       // GB recommended
  recommended: string;  // short recommendation
}

export const SAM_MODELS: SAMModelInfo[] = [
  {
    id: 'Xenova/sam-vit-base',
    name: 'SAM Base',
    size: '~178 MB',
    description: 'Modelo ligero con buena precisión. Ideal para la mayoría de dispositivos.',
    minRAM: 4,
    recommended: '4 GB RAM, cualquier GPU',
  },
  {
    id: 'Xenova/sam-vit-large',
    name: 'SAM Large',
    size: '~1.2 GB',
    description: 'Mayor precisión de segmentación, requiere más recursos.',
    minRAM: 8,
    recommended: '8+ GB RAM, GPU dedicada',
  },
];

// Device detection────
export interface DeviceSpecs {
  cpuCores: number;
  ramGB: number | null;          // navigator.deviceMemory (Chrome only)
  gpu: string;
  webGPU: boolean;
}

export function getDeviceSpecs(): DeviceSpecs {
  const cpuCores = navigator.hardwareConcurrency || 0;
  const ramGB = (navigator as any).deviceMemory ?? null;

  let gpu = 'No detectada';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || gpu;
      }
    }
  } catch { /* ignore */ }

  const webGPU = 'gpu' in navigator;

  return { cpuCores, ramGB, gpu, webGPU };
}

// Public types────
export interface SAMProgressInfo {
  status: string;
  progress?: number;
}

export interface SAMEmbeddings {
  imageEmbeddings: any;
  processedInputs: any;
  imageId: string;
  modelId: string;
}

// Model lifecycle────

export async function loadSAMModel(
  modelId: string,
  onProgress?: (info: SAMProgressInfo) => void,
): Promise<void> {
  if (model && processor && loadedModelId === modelId) return;

  if (model || processor) unloadSAMModel();

  if (loadPromise) { await loadPromise; return; }

  loadPromise = (async () => {
    try {
      onProgress?.({ status: 'Importando librería…', progress: 0 });

      // Ensure WASM proxy is enabled before any model loading
      await ensureWasmProxy();

      const { SamModel, AutoProcessor } = await import('@huggingface/transformers');

      // Large models often fail with WebGPU (too much VRAM / session creation issues).
      // Only attempt WebGPU for base-sized models.
      const isLarge = modelId.toLowerCase().includes('large');
      const useWebGPU = !isLarge && 'gpu' in navigator;
      const device = useWebGPU ? 'webgpu' : 'wasm';
      onProgress?.({ status: `Descargando modelo SAM… (${device})`, progress: 5 });

      const loadModel = async (dev: 'webgpu' | 'wasm') => {
        // Use quantized weights (int8) for WASM to avoid OOM and reduce computation time.
        // WebGPU can handle fp32/fp16 natively on the GPU.
        const dtypeOpts: Record<string, unknown> = dev === 'wasm'
          ? { dtype: 'q8' }
          : {};

        return SamModel.from_pretrained(modelId, {
          device: dev,
          ...dtypeOpts,
          progress_callback: (p: any) => {
            if (p.status === 'progress' && p.progress != null) {
              onProgress?.({ status: `Descargando: ${p.file ?? ''}`, progress: Math.round(p.progress) });
            }
          },
        });
      };

      try {
        model = await loadModel(device);
      } catch (gpuErr) {
        if (useWebGPU) {
          console.warn('WebGPU failed, falling back to WASM:', gpuErr);
          onProgress?.({ status: 'WebGPU no disponible, usando CPU…', progress: 5 });
          model = await loadModel('wasm');
        } else {
          throw gpuErr;
        }
      }

      onProgress?.({ status: 'Cargando procesador…', progress: 95 });
      processor = await AutoProcessor.from_pretrained(modelId);

      loadedModelId = modelId;
      onProgress?.({ status: 'Modelo listo', progress: 100 });
    } catch (err) {
      model = null;
      processor = null;
      loadedModelId = null;
      throw err;
    } finally {
      // Always reset so future calls don't hang on a stale promise
      loadPromise = null;
    }
  })();

  await loadPromise;
}

export function unloadSAMModel(): void {
  model = null;
  processor = null;
  loadPromise = null;
  loadedModelId = null;
  embeddingsCache.clear();
}

export function isSAMReady(): boolean {
  return model != null && processor != null;
}

export function getLoadedModelId(): string | null {
  return loadedModelId;
}

// Embeddings────

export async function getOrComputeEmbeddings(
  imageId: string,
  imageUrl: string,
  onProgress?: (progress: number) => void,
): Promise<SAMEmbeddings> {
  if (!model || !processor || !loadedModelId) throw new Error('Modelo SAM no cargado');

  const cacheKey = `${loadedModelId}::${imageId}`;
  const cached = embeddingsCache.get(cacheKey);
  if (cached) { onProgress?.(100); return cached; }

  onProgress?.(5);

  const RawImage = await getRawImage();
  onProgress?.(10);
  const rawImage = await RawImage.read(imageUrl);
  onProgress?.(25);
  const processedInputs = await processor(rawImage);
  onProgress?.(40);

  // Yield to the event loop so the UI can paint progress before the heavy encoder pass
  await new Promise(r => setTimeout(r, 0));

  let imageEmbeddings: any;
  try {
    imageEmbeddings = await model.get_image_embeddings(processedInputs);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    // Common WASM errors for large models: OOM, session failure
    if (/memory|oom|alloc|grow|out of/i.test(msg)) {
      throw new Error(
        'Sin memoria suficiente para calcular embeddings con este modelo. ' +
        'Prueba con un ROI m\u00e1s peque\u00f1o o usa el modelo Base.'
      );
    }
    throw new Error(`Error al calcular embeddings: ${msg}`);
  }
  onProgress?.(100);

  const emb: SAMEmbeddings = { imageEmbeddings, processedInputs, imageId, modelId: loadedModelId };
  embeddingsCache.set(cacheKey, emb);
  return emb;
}

export function getCachedEmbeddings(imageId: string): SAMEmbeddings | null {
  if (!loadedModelId) return null;
  return embeddingsCache.get(`${loadedModelId}::${imageId}`) ?? null;
}

export function hasEmbeddingsFor(imageId: string): boolean {
  if (!loadedModelId) return false;
  return embeddingsCache.has(`${loadedModelId}::${imageId}`);
}

export function clearEmbeddingsCache(imageId?: string): void {
  if (!imageId) { embeddingsCache.clear(); return; }
  for (const key of embeddingsCache.keys()) {
    if (key.endsWith(`::${imageId}`)) embeddingsCache.delete(key);
  }
}

/* ─── SAM Decode & Root Detection ─────────────────────────────────── */

export interface SAMDecodeResult {
  mask: boolean[][];
  width: number;
  height: number;
  score: number;
  /** All 3 SAM masks (for callers that want to pick their own) */
  allMasks: boolean[][][];
  allScores: number[];
  allAreas: number[];
}

/**
 * Run SAM mask decoder with point prompts.
 * All point coordinates must be in ROI-relative (0-based) space.
 *
 * Because we pass precomputed `imageEmbeddings` directly (bypassing the
 * SamModel coord-transform path), we must manually scale coordinates from
 * the original ROI size to the size the processor actually fed into the
 * encoder (stored in `reshaped_input_sizes`).
 */
export async function samDecodePoints(
  imageId: string,
  foregroundPoints: Array<{ x: number; y: number }>,
  backgroundPoints: Array<{ x: number; y: number }> = [],
): Promise<SAMDecodeResult | null> {
  const emb = getCachedEmbeddings(imageId);
  if (!emb || !model || !processor) return null;

  const allPts = [
    ...foregroundPoints.map(p => ({ x: p.x, y: p.y, label: 1 })),
    ...backgroundPoints.map(p => ({ x: p.x, y: p.y, label: 0 })),
  ];
  if (allPts.length === 0) return null;

  const { Tensor } = await import('@huggingface/transformers');

  /* ── Coordinate scaling: original → reshaped (model-internal) ── */
  let scaleX = 1;
  let scaleY = 1;
  try {
    const pi = emb.processedInputs;
    const origSizes = pi.original_sizes;
    const reshSizes = pi.reshaped_input_sizes;

    console.log('[SAM] processedInputs keys:', Object.keys(pi));
    console.log('[SAM] original_sizes:', origSizes);
    console.log('[SAM] reshaped_input_sizes:', reshSizes);

    // Sizes may be Tensors with .data, arrays, or nested arrays like [[H,W]]
    const readPair = (v: any): [number, number] => {
      if (v?.data) return [Number(v.data[0]), Number(v.data[1])];
      if (Array.isArray(v)) {
        const inner = Array.isArray(v[0]) ? v[0] : v;
        return [Number(inner[0]), Number(inner[1])];
      }
      return [0, 0];
    };

    const [oH, oW] = readPair(origSizes);
    const [rH, rW] = readPair(reshSizes);

    if (oW > 0 && oH > 0 && rW > 0 && rH > 0) {
      scaleX = rW / oW;
      scaleY = rH / oH;
    }
    // Store ROI dims for debug visualizer
    (samDecodePoints as any)._lastRoiW = oW;
    (samDecodePoints as any)._lastRoiH = oH;
  } catch (e) {
    console.warn('Could not read processedInputs sizes, skipping coord scaling', e);
  }

  const coords = new Float32Array(allPts.length * 2);
  const labels = new BigInt64Array(allPts.length);
  for (let i = 0; i < allPts.length; i++) {
    coords[i * 2]     = allPts[i].x * scaleX;
    coords[i * 2 + 1] = allPts[i].y * scaleY;
    labels[i] = BigInt(allPts[i].label);
  }

  const inputPoints = new Tensor('float32', coords, [1, 1, allPts.length, 2]);
  const inputLabels = new Tensor('int64', labels, [1, 1, allPts.length]);

  const outputs = await model({
    ...emb.imageEmbeddings,
    input_points: inputPoints,
    input_labels: inputLabels,
  });

  const masks = await processor.post_process_masks(
    outputs.pred_masks,
    emb.processedInputs.original_sizes,
    emb.processedInputs.reshaped_input_sizes,
  );

  /* ── Extract dimensions ── */
  const maskTensor = masks[0];
  const dims: number[] = Array.from(maskTensor.dims as Iterable<number>);
  const maskData = maskTensor.data as Float32Array;

  /* Resolve H, W.
   *   [1, 3, H, W]   — batch=1, numMasks=3, H, W   (4D — confirmed shape)
   *   [3, H, W]       — numMasks, H, W               (3D fallback)
   */
  let H: number, W: number, numMasks: number;
  if (dims.length === 4) {
    numMasks = dims[1]; H = dims[2]; W = dims[3];
  } else if (dims.length === 5) {
    numMasks = dims[2]; H = dims[3]; W = dims[4];
  } else {
    numMasks = dims[0]; H = dims[1]; W = dims[2];
  }
  const pixelsPerMask = H * W;

  /* ── Extract ALL masks & their areas ── */
  const allMasks: boolean[][][] = [];
  const allAreas: number[] = [];
  for (let m = 0; m < numMasks; m++) {
    const off = m * pixelsPerMask;
    const bm: boolean[][] = [];
    let area = 0;
    for (let y = 0; y < H; y++) {
      const row: boolean[] = new Array(W);
      for (let x = 0; x < W; x++) {
        row[x] = maskData[off + y * W + x] > 0;
        if (row[x]) area++;
      }
      bm.push(row);
    }
    allMasks.push(bm);
    allAreas.push(area);
  }

  /* ── IoU scores ── */
  const scoresData = outputs.iou_scores.data as Float32Array;
  const scoresDims: number[] = Array.from(outputs.iou_scores.dims as Iterable<number>);
  const numS = scoresDims[scoresDims.length - 1];
  const sOff = scoresData.length - numS;
  const scores: number[] = [];
  for (let i = 0; i < numS; i++) scores.push(scoresData[sOff + i]);

  /* ── Smart mask selection ──
   * SAM returns 3 masks at different granularity:
   *   - mask 0: coarsest (often the whole foreground = 80-95% of image)
   *   - mask 1: medium
   *   - mask 2: finest / most specific
   *
   * For root detection we want the most specific mask that has a
   * reasonable area (not the background-filling one).
   * Strategy: prefer masks that cover < 50% of the image.
   * Among those, pick the highest-scoring one.
   * If ALL masks are >50%, pick the smallest one.
   */
  const maxAreaRatio = 0.50;
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < numMasks; i++) {
    const ratio = allAreas[i] / pixelsPerMask;
    if (ratio <= maxAreaRatio && scores[i] > bestScore) {
      bestIdx = i;
      bestScore = scores[i];
    }
  }
  // Fallback: if all masks too large, pick the smallest one
  if (bestIdx < 0) {
    let minArea = Infinity;
    for (let i = 0; i < numMasks; i++) {
      if (allAreas[i] < minArea) { minArea = allAreas[i]; bestIdx = i; }
    }
  }
  if (bestIdx < 0) bestIdx = numMasks - 1;

  console.log('[SAM] mask selection: areas=', allAreas.map((a, i) => `m${i}:${(a / pixelsPerMask * 100).toFixed(1)}%`).join(' '),
    'scores=', scores.map(s => s.toFixed(3)).join(' '),
    '→ chose mask', bestIdx, `(${(allAreas[bestIdx] / pixelsPerMask * 100).toFixed(1)}%)`);

  // ── Debug visualizer ──
  if (isDebugEnabled()) {
    const roiW = (samDecodePoints as any)._lastRoiW || W;
    const roiH = (samDecodePoints as any)._lastRoiH || H;
    try {
      debugVisualizeSAM({
        fgPoints: foregroundPoints,
        bgPoints: backgroundPoints,
        roiWidth: roiW,
        roiHeight: roiH,
        allMasks,
        allAreas,
        scores,
        selectedIdx: bestIdx,
        maskH: H,
        maskW: W,
        roiImageUrl: getDebugROIImageUrl() ?? undefined,
      });
    } catch (e) {
      console.warn('[SAM Debug] visualization error:', e);
    }
  }

  return { mask: allMasks[bestIdx], width: W, height: H, score: scores[bestIdx], allMasks, allScores: scores, allAreas };
}

/* ─── Utility: invert a boolean mask ──────────────────────────────── */

function invertMask(mask: boolean[][]): boolean[][] {
  return mask.map(row => row.map(v => !v));
}

/* ─── Connected Component Labeling ────────────────────────────────── */

interface MaskComponent {
  /** Isolated boolean mask (same dimensions as source) with only this component */
  mask: boolean[][];
  /** Pixel count */
  area: number;
  /** Bounding box */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Label connected components in a boolean mask using BFS flood-fill (4-connected).
 * Returns an array of isolated components, sorted by area descending.
 */
function extractComponents(mask: boolean[][]): MaskComponent[] {
  const H = mask.length;
  if (H === 0) return [];
  const W = mask[0].length;

  const labels = new Int32Array(H * W);
  let nextLabel = 1;
  const compPixels = new Map<number, number>();
  const compBBox = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();

  const queue: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!mask[y][x] || labels[idx] !== 0) continue;
      const label = nextLabel++;
      labels[idx] = label;
      queue.length = 0;
      queue.push(idx);
      let area = 0;
      let bMinX = x, bMinY = y, bMaxX = x, bMaxY = y;
      let qi = 0;

      while (qi < queue.length) {
        const ci = queue[qi++];
        const cy = (ci / W) | 0;
        const cx = ci % W;
        area++;
        if (cx < bMinX) bMinX = cx;
        if (cx > bMaxX) bMaxX = cx;
        if (cy < bMinY) bMinY = cy;
        if (cy > bMaxY) bMaxY = cy;

        const nbrs = [
          cy > 0 ? ci - W : -1,
          cy < H - 1 ? ci + W : -1,
          cx > 0 ? ci - 1 : -1,
          cx < W - 1 ? ci + 1 : -1,
        ];
        for (const ni of nbrs) {
          if (ni < 0 || labels[ni] !== 0) continue;
          const ny = (ni / W) | 0;
          const nx = ni % W;
          if (!mask[ny][nx]) continue;
          labels[ni] = label;
          queue.push(ni);
        }
      }

      compPixels.set(label, area);
      compBBox.set(label, { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY });
    }
  }

  const components: MaskComponent[] = [];
  for (const [label, area] of compPixels) {
    const bb = compBBox.get(label)!;
    const cm: boolean[][] = [];
    for (let y = 0; y < H; y++) {
      const row = new Array<boolean>(W).fill(false);
      for (let x = 0; x < W; x++) {
        if (labels[y * W + x] === label) row[x] = true;
      }
      cm.push(row);
    }
    components.push({ mask: cm, area, bbox: bb });
  }

  components.sort((a, b) => b.area - a.area);
  return components;
}

/* ─── Skeletonization (Zhang-Suen thinning) ───────────────────────── */

export interface SkeletonizedInstance {
  mask: boolean[][];
  area: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Simplified skeleton (~25 pts) for visualization */
  skeleton: Array<{ x: number; y: number }>;
  /** Full-resolution original skeleton (directly after thinning, without cleanup) */
  rawSkeleton: Array<{ x: number; y: number }>;
}

/**
 * Zhang-Suen thinning algorithm.
 * Takes a component's bounding box area and produces a 1-pixel-wide skeleton.
 * Works on the cropped bbox for efficiency, then maps coords back.
 */
function skeletonize(comp: MaskComponent): { skeleton: Array<{ x: number; y: number }>; rawSkeleton: Array<{ x: number; y: number }> } {
  const { minX, minY, maxX, maxY } = comp.bbox;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  // Build a working grid (1 = foreground, 0 = background)
  // Pad by 1 pixel on each side so border checks are safe
  const pw = bw + 2;
  const ph = bh + 2;
  const grid: Uint8Array[] = [];
  for (let y = 0; y < ph; y++) {
    grid[y] = new Uint8Array(pw);
  }
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (comp.mask[y]?.[x]) {
        grid[y - minY + 1][x - minX + 1] = 1;
      }
    }
  }

  // Zhang-Suen neighborhood indices (P2..P9 clockwise from top)
  // P2=N, P3=NE, P4=E, P5=SE, P6=S, P7=SW, P8=W, P9=NW
  const dy = [-1, -1, 0, 1, 1,  1,  0, -1];
  const dx = [ 0,  1, 1, 1, 0, -1, -1, -1];

  let changed = true;
  while (changed) {
    changed = false;

    // Sub-iteration 1
    const toRemove1: Array<[number, number]> = [];
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1; x < pw - 1; x++) {
        if (!grid[y][x]) continue;
        const p: number[] = [];
        for (let i = 0; i < 8; i++) p[i] = grid[y + dy[i]][x + dx[i]];
        const B = p.reduce((s, v) => s + v, 0); // number of non-zero neighbors
        if (B < 2 || B > 6) continue;
        // A = number of 0→1 transitions in the sequence P2,P3,...,P9,P2
        let A = 0;
        for (let i = 0; i < 8; i++) {
          if (p[i] === 0 && p[(i + 1) % 8] === 1) A++;
        }
        if (A !== 1) continue;
        // Conditions for sub-iteration 1:
        // P2 * P4 * P6 == 0  AND  P4 * P6 * P8 == 0
        if (p[0] * p[2] * p[4] !== 0) continue;
        if (p[2] * p[4] * p[6] !== 0) continue;
        toRemove1.push([y, x]);
      }
    }
    for (const [y, x] of toRemove1) { grid[y][x] = 0; changed = true; }

    // Sub-iteration 2
    const toRemove2: Array<[number, number]> = [];
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1; x < pw - 1; x++) {
        if (!grid[y][x]) continue;
        const p: number[] = [];
        for (let i = 0; i < 8; i++) p[i] = grid[y + dy[i]][x + dx[i]];
        const B = p.reduce((s, v) => s + v, 0);
        if (B < 2 || B > 6) continue;
        let A = 0;
        for (let i = 0; i < 8; i++) {
          if (p[i] === 0 && p[(i + 1) % 8] === 1) A++;
        }
        if (A !== 1) continue;
        // Conditions for sub-iteration 2:
        // P2 * P4 * P8 == 0  AND  P2 * P6 * P8 == 0
        if (p[0] * p[2] * p[6] !== 0) continue;
        if (p[0] * p[4] * p[6] !== 0) continue;
        toRemove2.push([y, x]);
      }
    }
    for (const [y, x] of toRemove2) { grid[y][x] = 0; changed = true; }
  }

  // Collect ORIGINAL skeleton pixels right after thinning (no cleanup)
  const originalSkeleton: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < ph - 1; y++) {
    for (let x = 1; x < pw - 1; x++) {
      if (grid[y][x]) {
        originalSkeleton.push({ x: (x - 1) + minX, y: (y - 1) + minY });
      }
    }
  }

  // ─── Spur pruning: iteratively remove short branches ───
  // An endpoint has exactly 1 neighbor (8-connected).
  // Trace from each endpoint; if the branch length < threshold before
  // hitting a junction (≥3 neighbors), remove it.
  const spurThreshold = Math.max(5, Math.round(Math.max(bw, bh) * 0.08));

  const neighbors8 = (gy: number, gx: number): number => {
    let n = 0;
    for (let i = 0; i < 8; i++) {
      if (grid[gy + dy[i]][gx + dx[i]]) n++;
    }
    return n;
  };

  let pruned = true;
  while (pruned) {
    pruned = false;
    // Find all current endpoints
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1; x < pw - 1; x++) {
        if (!grid[y][x]) continue;
        if (neighbors8(y, x) !== 1) continue;
        // Trace the branch from this endpoint
        const branch: Array<[number, number]> = [[y, x]];
        let cy = y, cx = x;
        let prevY = -1, prevX = -1;
        let isJunction = false;
        while (branch.length <= spurThreshold) {
          // Find the next pixel (neighbor that isn't prev)
          let ny = -1, nx = -1, nCount = 0;
          for (let i = 0; i < 8; i++) {
            const ty = cy + dy[i], tx = cx + dx[i];
            if (!grid[ty][tx]) continue;
            if (ty === prevY && tx === prevX) continue;
            nCount++;
            ny = ty; nx = tx;
          }
          if (nCount === 0) break; // isolated endpoint — don't remove
          if (nCount >= 2) { isJunction = true; break; } // reached a junction
          branch.push([ny, nx]);
          prevY = cy; prevX = cx;
          cy = ny; cx = nx;
        }
        // Only prune if we reached a junction within the threshold
        if (isJunction && branch.length <= spurThreshold) {
          // Remove branch pixels (but not the junction pixel itself)
          for (const [by, bx] of branch) {
            grid[by][bx] = 0;
          }
          pruned = true;
        }
      }
    }
  }

  // Collect cleaned skeleton pixels, mapping back to original coords
  const cleanedSkeleton: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < ph - 1; y++) {
    for (let x = 1; x < pw - 1; x++) {
      if (grid[y][x]) {
        cleanedSkeleton.push({ x: (x - 1) + minX, y: (y - 1) + minY });
      }
    }
  }

  // ─── Extract longest path (eliminate remaining branches) ───
  const longestPath = extractLongestPath(cleanedSkeleton);

  // ─── Simplify to ~targetPoints using Ramer-Douglas-Peucker ───
  const targetPoints = 25;
  const simplified = simplifyPath(longestPath, targetPoints);

  return { skeleton: simplified, rawSkeleton: originalSkeleton };
}

/**
 * Build a graph from skeleton pixels (8-connected neighbors within 1px),
 * find the two endpoints of the longest path via double-BFS, then return
 * the ordered path between them.
 */
function extractLongestPath(
  points: Array<{ x: number; y: number }>
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;

  // Build adjacency via a spatial lookup
  const key = (x: number, y: number) => `${x},${y}`;
  const ptSet = new Set<string>();
  const ptMap = new Map<string, number>(); // key → index
  for (let i = 0; i < points.length; i++) {
    const k = key(points[i].x, points[i].y);
    ptSet.add(k);
    ptMap.set(k, i);
  }

  const adj: number[][] = Array.from({ length: points.length }, () => []);
  for (let i = 0; i < points.length; i++) {
    const { x, y } = points[i];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nk = key(x + dx, y + dy);
        const ni = ptMap.get(nk);
        if (ni !== undefined) adj[i].push(ni);
      }
    }
  }

  // BFS from a node, returns [farthest node index, dist array]
  const bfs = (start: number): [number, Int32Array] => {
    const dist = new Int32Array(points.length).fill(-1);
    dist[start] = 0;
    const queue = [start];
    let head = 0;
    let farthest = start;
    while (head < queue.length) {
      const u = queue[head++];
      for (const v of adj[u]) {
        if (dist[v] === -1) {
          dist[v] = dist[u] + 1;
          queue.push(v);
          if (dist[v] > dist[farthest]) farthest = v;
        }
      }
    }
    return [farthest, dist];
  };

  // Double BFS to find the diameter (longest shortest-path)
  const [endA] = bfs(0);
  const [endB, distFromA] = bfs(endA);

  // Reconstruct path from endA to endB via BFS parent tracking
  const parent = new Int32Array(points.length).fill(-1);
  const visited = new Uint8Array(points.length);
  visited[endA] = 1;
  const queue = [endA];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    if (u === endB) break;
    for (const v of adj[u]) {
      if (!visited[v]) {
        visited[v] = 1;
        parent[v] = u;
        queue.push(v);
      }
    }
  }

  const path: Array<{ x: number; y: number }> = [];
  let cur = endB;
  while (cur !== -1) {
    path.push(points[cur]);
    cur = parent[cur];
  }
  path.reverse();

  // If the graph is disconnected, path might be short; fall back to raw
  if (path.length < 2) return points;
  void distFromA; // suppress unused

  return path;
}

/**
 * Ramer-Douglas-Peucker line simplification.
 * Automatically finds the epsilon that yields ~targetN points.
 */
function simplifyPath(
  points: Array<{ x: number; y: number }>,
  targetN: number
): Array<{ x: number; y: number }> {
  if (points.length <= targetN) return points;

  // Perpendicular distance from point to line(a, b)
  const perpDist = (
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): number => {
    const dxAB = b.x - a.x, dyAB = b.y - a.y;
    const lenSq = dxAB * dxAB + dyAB * dyAB;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = ((p.x - a.x) * dxAB + (p.y - a.y) * dyAB) / lenSq;
    const projX = a.x + t * dxAB, projY = a.y + t * dyAB;
    return Math.hypot(p.x - projX, p.y - projY);
  };

  const rdp = (
    pts: Array<{ x: number; y: number }>,
    eps: number
  ): Array<{ x: number; y: number }> => {
    if (pts.length <= 2) return pts;
    let maxD = 0, maxI = 0;
    const first = pts[0], last = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpDist(pts[i], first, last);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps) {
      const left = rdp(pts.slice(0, maxI + 1), eps);
      const right = rdp(pts.slice(maxI), eps);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  };

  // Binary search for the epsilon that yields ~targetN points
  let lo = 0, hi = 0;
  // Find upper bound for epsilon
  for (let i = 0; i < points.length; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > hi) hi = d;
  }
  hi *= 2;

  let best = points;
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2;
    const result = rdp(points, mid);
    if (result.length > targetN) {
      lo = mid;
    } else {
      hi = mid;
      best = result;
    }
    if (Math.abs(result.length - targetN) <= 2) { best = result; break; }
  }

  return best;
}

/* ─── Public root-detection API ───────────────────────────────────── */

/** A candidate mask (inverted = roots are true) for user selection. */
export interface MaskCandidate {
  idx: number;
  /** Inverted mask (roots = true) */
  mask: boolean[][];
  /** Pixel count of root area */
  rootArea: number;
  /** Root area as fraction of total */
  rootPct: number;
  /** Connected components above noise threshold */
  numComps: number;
  /** Mean area of those components */
  avgCompArea: number;
  /** Original SAM IoU score */
  iouScore: number;
  /** Mask dimensions */
  maskH: number;
  maskW: number;
}

/** Result of computing mask candidates (phase 1). */
export interface MaskCandidatesResult {
  candidates: MaskCandidate[];
  /** Raw SAM result dimensions */
  maskH: number;
  maskW: number;
  /** ROI dimensions */
  roiW: number;
  roiH: number;
}

/** Result of processing a chosen mask (phase 2). */
export interface ProcessedMaskResult {
  rootsMask: boolean[][];
  rootsArea: number;
  instances: SkeletonizedInstance[];
  maskH: number;
  maskW: number;
  roiW: number;
  roiH: number;
}

/**
 * Phase 1: Compute SAM masks using TWO different point configurations
 * and return all 6 inverted candidates for user selection.
 */
export async function computeMaskCandidates(
  imageId: string,
  roi: ROIRegion,
  onProgress?: (pct: number, msg: string) => void,
): Promise<MaskCandidatesResult> {
  if (!getCachedEmbeddings(imageId) || !model || !processor) {
    throw new Error('Embeddings no calculados');
  }

  const roiW = Math.round(roi.width);
  const roiH = Math.round(roi.height);

  /* ── Run A: regular grid + 4 bg corners ─────────────────────────── */
  onProgress?.(5, 'Obteniendo máscaras de SAM (1/2)…');

  const numColsA = Math.max(3, Math.min(8, Math.round(roiW / 60)));
  const numRowsA = Math.max(3, Math.min(6, Math.round(roiH / 80)));
  const fgA: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < numRowsA; r++) {
    for (let c = 0; c < numColsA; c++) {
      fgA.push({
        x: roiW * (c + 1) / (numColsA + 1),
        y: roiH * (r + 1) / (numRowsA + 1),
      });
    }
  }
  const bgCornersA = [
    { x: 2, y: 2 }, { x: roiW - 3, y: 2 },
    { x: 2, y: roiH - 3 }, { x: roiW - 3, y: roiH - 3 },
  ];

  const resA = await samDecodePoints(imageId, fgA, bgCornersA);
  if (!resA) { throw new Error('No se obtuvo máscara de SAM (run A)'); }

  /* ── Run B: offset / sparser grid, no bg corners ────────────────── */
  onProgress?.(25, 'Obteniendo máscaras de SAM (2/2)…');

  const numColsB = Math.max(2, Math.min(6, Math.round(roiW / 90)));
  const numRowsB = Math.max(2, Math.min(5, Math.round(roiH / 100)));
  const fgB: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < numRowsB; r++) {
    for (let c = 0; c < numColsB; c++) {
      fgB.push({
        x: roiW * (c + 0.5) / (numColsB),
        y: roiH * (r + 0.5) / (numRowsB),
      });
    }
  }
  // Run B: no background points — lets SAM decide freely
  const resB = await samDecodePoints(imageId, fgB, []);
  if (!resB) { throw new Error('No se obtuvo máscara de SAM (run B)'); }

  onProgress?.(45, 'Analizando máscaras…');
  await new Promise(r => setTimeout(r, 0));

  /* ── Analyse all masks from both runs ───────────────────────────── */
  const allRuns: Array<{ res: SAMDecodeResult; label: string }> = [
    { res: resA, label: 'A' },
    { res: resB, label: 'B' },
  ];

  const candidates: MaskCandidate[] = [];
  let globalIdx = 0;

  for (const { res, label } of allRuns) {
    const totalPx = res.height * res.width;
    const noiseThreshold = Math.max(20, totalPx * 0.0005);

    for (let i = 0; i < res.allMasks.length; i++) {
      const inverted = invertMask(res.allMasks[i]);
      const rootArea = totalPx - res.allAreas[i];
      const rootPct = rootArea / totalPx;

      // Quick connected-component count on the inverted mask
      const H = res.height, W = res.width;
      const visited = new Uint8Array(H * W);
      let numComps = 0;
      let totalCompArea = 0;
      const queue: number[] = [];

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          if (!inverted[y][x] || visited[idx]) continue;
          visited[idx] = 1;
          queue.length = 0;
          queue.push(idx);
          let area = 0;
          let qi = 0;
          while (qi < queue.length) {
            const ci = queue[qi++];
            area++;
            const cy = (ci / W) | 0;
            const cx = ci % W;
            const nbrs = [
              cy > 0 ? ci - W : -1,
              cy < H - 1 ? ci + W : -1,
              cx > 0 ? ci - 1 : -1,
              cx < W - 1 ? ci + 1 : -1,
            ];
            for (const ni of nbrs) {
              if (ni < 0 || visited[ni]) continue;
              const ny = (ni / W) | 0;
              const nx = ni % W;
              if (!inverted[ny][nx]) continue;
              visited[ni] = 1;
              queue.push(ni);
            }
          }
          if (area >= noiseThreshold) {
            numComps++;
            totalCompArea += area;
          }
        }
      }

      const avgCompArea = numComps > 0 ? totalCompArea / numComps : 0;

      candidates.push({
        idx: globalIdx++,
        mask: inverted,
        rootArea,
        rootPct,
        numComps,
        avgCompArea,
        iouScore: res.allScores[i],
        maskH: res.height,
        maskW: res.width,
      });

      console.log(`[SAM] candidate ${label}${i} (idx=${globalIdx - 1}): rootArea=${rootArea} (${(rootPct * 100).toFixed(1)}%), comps=${numComps}, avgArea=${Math.round(avgCompArea)}, iou=${res.allScores[i].toFixed(3)}`);
    }
  }

  onProgress?.(60, `${candidates.length} máscaras listas para elegir`);

  /* Debug visualization (show run A masks only for backward compat) */
  if (isDebugEnabled()) {
    try {
      const { debugVisualizeRootsMask } = await import('./samDebugVisualizer');
      debugVisualizeRootsMask({
        roiWidth: roiW,
        roiHeight: roiH,
        maskH: resA.height,
        maskW: resA.width,
        allMasks: resA.allMasks,
        allAreas: resA.allAreas,
        scores: resA.allScores,
        chosenMaskIdx: -1,
        rootsMask: candidates[0].mask,
        rootsArea: candidates[0].rootArea,
        roiImageUrl: getDebugROIImageUrl() ?? undefined,
      });
    } catch (e) { console.warn('[SAM Debug] viz error:', e); }
  }

  return { candidates, maskH: resA.height, maskW: resA.width, roiW, roiH };
}

/**
 * Phase 2: Process a user-chosen mask — border cleanup, instance segmentation, skeletonization.
 */
export async function processChosenMask(
  candidate: MaskCandidate,
  roiW: number,
  roiH: number,
  onProgress?: (pct: number, msg: string) => void,
): Promise<ProcessedMaskResult> {
  const { maskH, maskW } = candidate;
  let rootsMask = candidate.mask; // already inverted

  onProgress?.(10, 'Limpiando bordes…');

  /* Trim a fixed border strip (~10 px) instead of removing full border-connected regions */
  {
    const H = maskH, W = maskW;
    const borderPad = Math.max(1, Math.min(10, Math.floor(Math.min(H, W) / 2)));
    let removed = 0;
    const cleaned: boolean[][] = [];
    for (let y = 0; y < H; y++) {
      const row: boolean[] = new Array(W);
      for (let x = 0; x < W; x++) {
        const inBorderStrip =
          y < borderPad || y >= H - borderPad ||
          x < borderPad || x >= W - borderPad;
        if (inBorderStrip && rootsMask[y][x]) {
          row[x] = false;
          removed++;
        } else {
          row[x] = rootsMask[y][x];
        }
      }
      cleaned.push(row);
    }
    rootsMask = cleaned;
    console.log(`[SAM] border cleanup (strip=${borderPad}px): removed ${removed} pixels`);
  }

  const rootsArea = rootsMask.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const totalPx = maskH * maskW;

  onProgress?.(30, 'Separando instancias…');
  await new Promise(r => setTimeout(r, 0));

  const components = extractComponents(rootsMask);
  const minInstanceArea = Math.max(20, totalPx * 0.0003);
  const rootInstances = components.filter(c => c.area >= minInstanceArea);

  console.log(`[SAM] instances: ${components.length} → ${rootInstances.length} after noise filter`);

  onProgress?.(60, 'Calculando esqueletos…');
  await new Promise(r => setTimeout(r, 0));

  const skelInstances: SkeletonizedInstance[] = rootInstances.map((inst, i) => {
    const { skeleton, rawSkeleton } = skeletonize(inst);
    console.log(`  [${i}] area=${inst.area} skeleton=${skeleton.length}pts rawSkeleton=${rawSkeleton.length}pts`);
    return { ...inst, skeleton, rawSkeleton };
  });

  onProgress?.(90, `${skelInstances.length} esqueletos calculados`);

  /* Debug visualization */
  if (isDebugEnabled()) {
    try {
      const { debugVisualizeInstances, debugVisualizeSkeletons } = await import('./samDebugVisualizer');
      debugVisualizeInstances({
        roiWidth: roiW, roiHeight: roiH,
        maskH, maskW,
        instances: rootInstances,
        roiImageUrl: getDebugROIImageUrl() ?? undefined,
      });
      debugVisualizeSkeletons({
        roiWidth: roiW, roiHeight: roiH,
        maskH, maskW,
        instances: skelInstances,
        roiImageUrl: getDebugROIImageUrl() ?? undefined,
      });
    } catch (e) { console.warn('[SAM Debug] viz error:', e); }
  }

  onProgress?.(100, 'Listo');
  return { rootsMask, rootsArea, instances: skelInstances, maskH, maskW, roiW, roiH };
}

/**
 * Snap a user-drawn path to the nearest skeleton.
 * Finds the skeleton whose path is closest to the drawn line,
 * then returns the sub-section of that skeleton between the
 * start and end projections.
 *
 * All coordinates are in mask space — caller must convert to/from image coords.
 */
export function snapToSkeleton(
  drawnPoints: Array<{ x: number; y: number }>,
  skeletons: SkeletonizedInstance[],
): Array<{ x: number; y: number }> | null {
  if (drawnPoints.length < 2 || skeletons.length === 0) return null;

  const drawStart = drawnPoints[0];
  const drawEnd = drawnPoints[drawnPoints.length - 1];

  // For each skeleton, find the closest point to the start and end of the drawn line
  // and compute a valid graph path on the ORIGINAL (unpruned) skeleton.
  let bestSkel: SkeletonizedInstance | null = null;
  let bestPath: Array<{ x: number; y: number }> | null = null;
  let bestStartIdx = 0;
  let bestEndIdx = 0;
  let bestDist = Infinity;

  const buildAdjacency = (points: Array<{ x: number; y: number }>): number[][] => {
    const key = (x: number, y: number) => `${x},${y}`;
    const ptMap = new Map<string, number>();
    for (let i = 0; i < points.length; i++) {
      ptMap.set(key(points[i].x, points[i].y), i);
    }

    const adj: number[][] = Array.from({ length: points.length }, () => []);
    for (let i = 0; i < points.length; i++) {
      const { x, y } = points[i];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = ptMap.get(key(x + dx, y + dy));
          if (ni !== undefined) adj[i].push(ni);
        }
      }
    }
    return adj;
  };

  const shortestPath = (
    points: Array<{ x: number; y: number }>,
    adj: number[][],
    startIdx: number,
    endIdx: number,
  ): Array<{ x: number; y: number }> | null => {
    if (startIdx === endIdx) return [points[startIdx]];

    const parent = new Int32Array(points.length).fill(-1);
    const visited = new Uint8Array(points.length);
    const queue: number[] = [startIdx];
    visited[startIdx] = 1;

    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      if (u === endIdx) break;
      for (const v of adj[u]) {
        if (!visited[v]) {
          visited[v] = 1;
          parent[v] = u;
          queue.push(v);
        }
      }
    }

    if (!visited[endIdx]) return null;

    const path: Array<{ x: number; y: number }> = [];
    let cur = endIdx;
    while (cur !== -1) {
      path.push(points[cur]);
      cur = parent[cur];
    }
    path.reverse();
    return path;
  };

  for (const skel of skeletons) {
    // Use original (full-resolution, unpruned) skeleton for snapping
    const raw = skel.rawSkeleton;
    if (raw.length < 2) continue;
    const adj = buildAdjacency(raw);

    // Find closest skeleton point to drawn start
    let sIdx = 0, sMinD = Infinity;
    for (let i = 0; i < raw.length; i++) {
      const d = Math.hypot(raw[i].x - drawStart.x, raw[i].y - drawStart.y);
      if (d < sMinD) { sMinD = d; sIdx = i; }
    }

    // Find closest skeleton point to drawn end
    let eIdx = 0, eMinD = Infinity;
    for (let i = 0; i < raw.length; i++) {
      const d = Math.hypot(raw[i].x - drawEnd.x, raw[i].y - drawEnd.y);
      if (d < eMinD) { eMinD = d; eIdx = i; }
    }

    // Also score by average distance of drawn midpoints to skeleton
    const midSamples = Math.min(10, drawnPoints.length);
    let midDist = 0;
    for (let s = 0; s < midSamples; s++) {
      const dp = drawnPoints[Math.floor(s * drawnPoints.length / midSamples)];
      let minD = Infinity;
      for (const sp of raw) {
        const d = Math.hypot(sp.x - dp.x, sp.y - dp.y);
        if (d < minD) minD = d;
      }
      midDist += minD;
    }
    midDist /= midSamples;

    const path = shortestPath(raw, adj, sIdx, eIdx);
    if (!path || path.length < 2) continue;

    const totalDist = sMinD + eMinD + midDist * 2;
    if (totalDist < bestDist) {
      bestDist = totalDist;
      bestSkel = skel;
      bestPath = path;
      bestStartIdx = sIdx;
      bestEndIdx = eIdx;
    }
  }

  if (!bestSkel || !bestPath) return null;
  void bestStartIdx;
  void bestEndIdx;
  return bestPath.length >= 2 ? bestPath : null;
}

/**
 * Automatically detect roots inside the ROI (kept for backward compat).
 * Uses the new phased API internally.
 */
export async function autoDetectRoots(
  imageId: string,
  roi: ROIRegion,
  onProgress?: (pct: number, msg: string) => void,
): Promise<DrawingPoint[][]> {
  const { candidates } = await computeMaskCandidates(imageId, roi, (p, m) => onProgress?.(p * 0.5, m));

  // Auto-select: prefer masks with root area 3–55%, then largest avgCompArea
  const viable = candidates.filter(c => c.rootPct >= 0.03 && c.rootPct <= 0.55 && c.numComps >= 1);
  let best: MaskCandidate;
  if (viable.length > 0) {
    best = viable.reduce((a, b) => b.avgCompArea > a.avgCompArea ? b : a);
  } else {
    best = candidates.reduce((a, b) => Math.abs(a.rootPct - 0.20) < Math.abs(b.rootPct - 0.20) ? a : b);
  }

  await processChosenMask(best, Math.round(roi.width), Math.round(roi.height), (p, m) => onProgress?.(50 + p * 0.5, m));

  onProgress?.(100, 'Completado');
  return [];
}
