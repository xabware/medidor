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

/* ─── Mask analysis helpers ───────────────────────────────────────── */

function getMaskBBox(mask: boolean[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const H = mask.length;
  if (H === 0) return null;
  const W = mask[0].length;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y][x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/* ─── Connected Component Analysis ────────────────────────────────── */

interface MaskComponent {
  /** Isolated boolean mask (same dimensions as source) with only this component */
  mask: boolean[][];
  /** Pixel count */
  area: number;
  /** Bounding box */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Label connected components in a boolean mask using flood-fill (4-connected).
 * Returns an array of isolated components, sorted by area descending.
 */
function extractComponents(mask: boolean[][]): MaskComponent[] {
  const H = mask.length;
  if (H === 0) return [];
  const W = mask[0].length;

  // Label grid: 0 = unlabeled/background, >0 = component id
  const labels = new Int32Array(H * W);
  let nextLabel = 1;
  const compPixels = new Map<number, number>(); // label → area
  const compBBox = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();

  // BFS flood-fill
  const queue: number[] = []; // flat indices
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!mask[y][x] || labels[idx] !== 0) continue;
      // Start new component
      const label = nextLabel++;
      labels[idx] = label;
      queue.push(idx);
      let area = 0;
      let bMinX = x, bMinY = y, bMaxX = x, bMaxY = y;

      while (queue.length > 0) {
        const ci = queue.pop()!;
        const cy = (ci / W) | 0;
        const cx = ci % W;
        area++;
        if (cx < bMinX) bMinX = cx;
        if (cx > bMaxX) bMaxX = cx;
        if (cy < bMinY) bMinY = cy;
        if (cy > bMaxY) bMaxY = cy;

        // 4-connected neighbors
        const neighbors = [
          cy > 0 ? ci - W : -1,
          cy < H - 1 ? ci + W : -1,
          cx > 0 ? ci - 1 : -1,
          cx < W - 1 ? ci + 1 : -1,
        ];
        for (const ni of neighbors) {
          if (ni < 0) continue;
          if (labels[ni] !== 0) continue;
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

  // Build isolated masks per component
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

  // Sort by area descending
  components.sort((a, b) => b.area - a.area);
  return components;
}

/* ─── Morphological erosion for splitting connected blobs ─────────── */

/**
 * Erode a boolean mask by `iterations` steps (4-connected).
 * Each iteration removes boundary pixels (pixels with at least one false neighbor).
 */
function erodeMask(mask: boolean[][], iterations: number): boolean[][] {
  const H = mask.length;
  const W = mask[0]?.length ?? 0;
  let current = mask;

  for (let iter = 0; iter < iterations; iter++) {
    const next: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (current[y][x] && current[y - 1][x] && current[y + 1][x] && current[y][x - 1] && current[y][x + 1]) {
          next[y][x] = true;
        }
      }
    }
    current = next;
  }
  return current;
}

/**
 * Given eroded seed components, expand them back into the original mask
 * using multi-source BFS. Each original-mask pixel gets assigned to the
 * nearest seed, effectively partitioning the mask along the erosion gaps.
 */
function expandSeedsToOriginal(
  seeds: MaskComponent[],
  originalMask: boolean[][],
  H: number,
  W: number,
): MaskComponent[] {
  const labels = new Int32Array(H * W);
  const queue: number[] = [];

  // Label all seed pixels
  for (let si = 0; si < seeds.length; si++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (seeds[si].mask[y]?.[x]) {
          const idx = y * W + x;
          labels[idx] = si + 1;
          queue.push(idx);
        }
      }
    }
  }

  // Multi-source BFS — expand into unclaimed original-mask pixels
  let qi = 0;
  while (qi < queue.length) {
    const idx = queue[qi++];
    const y = (idx / W) | 0;
    const x = idx % W;
    const lbl = labels[idx];

    const offsets = [y > 0 ? -W : 0, y < H - 1 ? W : 0, x > 0 ? -1 : 0, x < W - 1 ? 1 : 0];
    for (const off of offsets) {
      if (off === 0) continue;
      const ni = idx + off;
      if (labels[ni] !== 0) continue;
      const ny = (ni / W) | 0;
      const nx = ni % W;
      if (!originalMask[ny][nx]) continue;
      labels[ni] = lbl;
      queue.push(ni);
    }
  }

  // Build MaskComponent per seed label
  const results: MaskComponent[] = [];
  for (let si = 0; si < seeds.length; si++) {
    const lbl = si + 1;
    let area = 0;
    let bMinX = W, bMinY = H, bMaxX = 0, bMaxY = 0;
    const cm: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (labels[y * W + x] === lbl) {
          cm[y][x] = true;
          area++;
          if (x < bMinX) bMinX = x;
          if (x > bMaxX) bMaxX = x;
          if (y < bMinY) bMinY = y;
          if (y > bMaxY) bMaxY = y;
        }
      }
    }
    if (area > 0) {
      results.push({ mask: cm, area, bbox: { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY } });
    }
  }
  return results;
}

/**
 * Try to split a large connected component into multiple roots via
 * progressive morphological erosion.  Tries 1→12 erosion iterations;
 * as soon as the eroded mask yields ≥ 2 components (each ≥ 2% of the
 * original), we expand them back into the original mask.
 */
function splitLargeComponent(comp: MaskComponent): MaskComponent[] {
  const H = comp.mask.length;
  const W = comp.mask[0]?.length ?? 0;

  for (let iters = 1; iters <= 12; iters++) {
    const eroded = erodeMask(comp.mask, iters);
    const erodedComps = extractComponents(eroded);
    const minSeedArea = Math.max(10, comp.area * 0.02);
    const seeds = erodedComps.filter(c => c.area >= minSeedArea);

    if (seeds.length >= 2) {
      console.log(`[SAM] erosion(${iters}): split into ${seeds.length} seeds (areas: ${seeds.map(s => s.area).join(',')})`);
      return expandSeedsToOriginal(seeds, comp.mask, H, W);
    }
  }

  // Couldn't split — return original component unchanged
  return [comp];
}

/* ─── Root cluster detection ──────────────────────────────────────── */

interface TaggedComponent extends MaskComponent {
  maskIdx: number;
}

/**
 * Pool components from ALL masks, split large blobs via erosion,
 * cluster by area, deduplicate spatially.
 *
 * SAM may segment either the roots themselves (true pixels) or the
 * background/substrate (true pixels, roots = false pixels). We try
 * BOTH orientations (normal + inverted) for each mask and pick the
 * best overall cluster.
 *
 * Returns the final root components AND the raw per-mask components
 * (for debug visualization).
 */
function findBestRootCluster(
  allMasks: boolean[][][],
  totalPixels: number,
): {
  components: MaskComponent[];
  maskSources: number[];
  rawPerMask: MaskComponent[][];
} {
  const allComps: TaggedComponent[] = [];
  const rawPerMask: MaskComponent[][] = [];

  // Large component threshold: anything above this % will be erosion-split
  const splitThreshold = totalPixels * 0.15;

  /** Invert a boolean mask */
  const invertMask = (mask: boolean[][]): boolean[][] =>
    mask.map(row => row.map(v => !v));

  for (let mi = 0; mi < allMasks.length; mi++) {
    // Extract components from BOTH the normal mask and its inverse
    const normal = extractComponents(allMasks[mi]);
    const inverted = extractComponents(invertMask(allMasks[mi]));

    // Show both in raw debug — label inverted with suffix
    const allRaw = [...normal, ...inverted];
    rawPerMask.push(allRaw);

    console.log(`[SAM] mask ${mi}: ${normal.length} normal + ${inverted.length} inverted components`);
    console.log(`[SAM]   normal areas:   [${normal.slice(0, 6).map(c => c.area).join(', ')}]`);
    console.log(`[SAM]   inverted areas: [${inverted.slice(0, 6).map(c => c.area).join(', ')}]`);

    // Pool both orientations
    for (const batch of [normal, inverted]) {
      for (const c of batch) {
        if (c.area > splitThreshold) {
          console.log(`[SAM] mask ${mi}: large blob (${c.area}px = ${(c.area / totalPixels * 100).toFixed(1)}%), splitting via erosion…`);
          const split = splitLargeComponent(c);
          console.log(`[SAM] mask ${mi}: erosion produced ${split.length} sub-components`);
          for (const sc of split) allComps.push({ ...sc, maskIdx: mi });
        } else {
          allComps.push({ ...c, maskIdx: mi });
        }
      }
    }
  }

  console.log(`[SAM] total pooled components (normal + inverted, after erosion): ${allComps.length}`);

  // Filter: remove tiny noise (but NO upper limit since we already split large ones)
  const absMinArea = Math.max(50, totalPixels * 0.0003);
  const viable = allComps.filter(c => {
    if (c.area < absMinArea) return false;
    const bw = c.bbox.maxX - c.bbox.minX + 1;
    const bh = c.bbox.maxY - c.bbox.minY + 1;
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (aspect < 1.3) return false; // relaxed from 1.5
    return true;
  });

  console.log(`[SAM] after basic filter: ${viable.length} viable components`);

  if (viable.length === 0) {
    return { components: [], maskSources: [], rawPerMask };
  }

  // Sort by area
  viable.sort((a, b) => a.area - b.area);

  // Sliding window: find the widest window where max/min area ratio ≤ R
  const R = 8; // relaxed from 5
  let bestStart = 0, bestEnd = 0;
  let start = 0;
  for (let end = 0; end < viable.length; end++) {
    while (viable[end].area > viable[start].area * R) start++;
    if (end - start > bestEnd - bestStart) {
      bestStart = start;
      bestEnd = end;
    }
  }

  const cluster = viable.slice(bestStart, bestEnd + 1);
  console.log(`[SAM] cluster: ${cluster.length} components, area range ${cluster[0]?.area}–${cluster[cluster.length - 1]?.area}px`);

  // Deduplicate spatially: overlapping bbox → same root from different masks → keep larger
  const deduped: TaggedComponent[] = [];
  for (const comp of cluster) {
    const overlapIdx = deduped.findIndex(existing => {
      const ox = Math.max(existing.bbox.minX, comp.bbox.minX);
      const oy = Math.max(existing.bbox.minY, comp.bbox.minY);
      const ex = Math.min(existing.bbox.maxX, comp.bbox.maxX);
      const ey = Math.min(existing.bbox.maxY, comp.bbox.maxY);
      if (ex <= ox || ey <= oy) return false;
      const overlapArea = (ex - ox) * (ey - oy);
      const smallerBBoxArea = Math.min(
        (existing.bbox.maxX - existing.bbox.minX) * (existing.bbox.maxY - existing.bbox.minY),
        (comp.bbox.maxX - comp.bbox.minX) * (comp.bbox.maxY - comp.bbox.minY),
      );
      return overlapArea / Math.max(1, smallerBBoxArea) > 0.4;
    });

    if (overlapIdx >= 0) {
      if (comp.area > deduped[overlapIdx].area) deduped[overlapIdx] = comp;
    } else {
      deduped.push(comp);
    }
  }

  console.log(`[SAM] after dedup: ${deduped.length} unique root components`);
  return {
    components: deduped,
    maskSources: deduped.map(c => c.maskIdx),
    rawPerMask,
  };
}

/* ─── Path utilities ──────────────────────────────────────────────── */

function perpDist(p: DrawingPoint, a: DrawingPoint, b: DrawingPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(lenSq);
}

/** Douglas-Peucker path simplification. */
function simplifyPath(pts: DrawingPoint[], epsilon: number): DrawingPoint[] {
  if (pts.length <= 2) return [...pts];
  let maxD = 0, maxI = 0;
  const first = pts[0], last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], first, last);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > epsilon) {
    const left = simplifyPath(pts.slice(0, maxI + 1), epsilon);
    const right = simplifyPath(pts.slice(maxI), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

/** Sample N points uniformly along a polyline. */
function sampleAlongPath(pts: DrawingPoint[], n: number): DrawingPoint[] {
  if (pts.length <= 1 || n <= 1) return pts.length ? [pts[0]] : [];
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(l);
    total += l;
  }
  if (total === 0) return [pts[0]];
  const step = total / (n - 1);
  const out: DrawingPoint[] = [];
  for (let i = 0; i < n; i++) {
    const target = i * step;
    let acc = 0;
    for (let s = 0; s < segs.length; s++) {
      if (acc + segs[s] >= target || s === segs.length - 1) {
        const t = segs[s] > 0 ? Math.min(1, (target - acc) / segs[s]) : 0;
        out.push({
          x: pts[s].x + t * (pts[s + 1].x - pts[s].x),
          y: pts[s].y + t * (pts[s + 1].y - pts[s].y),
        });
        break;
      }
      acc += segs[s];
    }
  }
  return out;
}

/**
 * Convert a binary mask to a centerline path (full-image coords).
 * Scans along the primary axis, taking the center of each cross-section.
 */
function maskToCenterline(mask: boolean[][], roiX: number, roiY: number): DrawingPoint[] {
  const bbox = getMaskBBox(mask);
  if (!bbox) return [];
  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  const vertical = bh >= bw;

  const raw: DrawingPoint[] = [];
  if (vertical) {
    for (let y = bbox.minY; y <= bbox.maxY; y++) {
      let sx = 0, cnt = 0;
      for (let x = bbox.minX; x <= bbox.maxX; x++) {
        if (mask[y][x]) { sx += x; cnt++; }
      }
      if (cnt) raw.push({ x: sx / cnt + roiX, y: y + roiY });
    }
  } else {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      let sy = 0, cnt = 0;
      for (let y = bbox.minY; y <= bbox.maxY; y++) {
        if (mask[y][x]) { sy += y; cnt++; }
      }
      if (cnt) raw.push({ x: x + roiX, y: sy / cnt + roiY });
    }
  }
  return simplifyPath(raw, 1.5);
}

/* ─── Public root-detection API ───────────────────────────────────── */

/** Mean distance from each point in `testPath` to the nearest point in `refPath`. */
function meanDistToPath(testPath: DrawingPoint[], refPath: DrawingPoint[]): number {
  if (testPath.length === 0 || refPath.length === 0) return Infinity;
  let total = 0;
  for (const p of testPath) {
    let best = Infinity;
    for (const r of refPath) {
      const d = Math.hypot(p.x - r.x, p.y - r.y);
      if (d < best) best = d;
    }
    total += best;
  }
  return total / testPath.length;
}

/**
 * Refine a user-drawn freehand path using SAM point prompts.
 * 
 * Gets all SAM masks, extracts components from each, finds the component
 * closest to the user's drawn path across all masks.
 *
 * `drawnPoints` and the returned path are in **full-image** coordinates.
 */
export async function refineDrawnPath(
  imageId: string,
  drawnPoints: DrawingPoint[],
  roi: ROIRegion,
): Promise<DrawingPoint[] | null> {
  if (drawnPoints.length < 2) return null;

  const roiW = Math.round(roi.width);
  const roiH = Math.round(roi.height);

  /* Convert to ROI-relative coords */
  const roiPts = drawnPoints.map(p => ({ x: p.x - roi.x, y: p.y - roi.y }));

  const numFg = Math.min(12, Math.max(4, Math.ceil(drawnPoints.length / 15)));
  const fgSampled = sampleAlongPath(roiPts, numFg);

  const bgCorners: DrawingPoint[] = [
    { x: 2, y: 2 }, { x: roiW - 3, y: 2 },
    { x: 2, y: roiH - 3 }, { x: roiW - 3, y: roiH - 3 },
  ];

  const clamp = (p: { x: number; y: number }) => ({
    x: Math.max(0, Math.min(roiW - 1, p.x)),
    y: Math.max(0, Math.min(roiH - 1, p.y)),
  });
  const fg = fgSampled.map(clamp);

  /* SAM call */
  const result = await samDecodePoints(imageId, fg, bgCorners);
  if (!result) return null;

  /* Search ALL masks → ALL components → pick the closest to the drawn path */
  const totalPx = result.height * result.width;
  const minCompArea = Math.max(50, totalPx * 0.0003);
  let bestCL: DrawingPoint[] | null = null;
  let bestDist = Infinity;

  for (let mi = 0; mi < result.allMasks.length; mi++) {
    const components = extractComponents(result.allMasks[mi]);
    for (const comp of components) {
      if (comp.area < minCompArea) continue;
      const bw = comp.bbox.maxX - comp.bbox.minX + 1;
      const bh = comp.bbox.maxY - comp.bbox.minY + 1;
      if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) < 1.5) continue;

      const cl = maskToCenterline(comp.mask, 0, 0);
      if (cl.length < 2) continue;

      const dist = meanDistToPath(cl, roiPts);
      if (dist < bestDist) {
        bestDist = dist;
        bestCL = cl;
      }
    }
  }

  if (!bestCL) return null;

  const pathLen = (() => {
    let l = 0;
    for (let i = 1; i < roiPts.length; i++) l += Math.hypot(roiPts[i].x - roiPts[i - 1].x, roiPts[i].y - roiPts[i - 1].y);
    return l;
  })();
  const tolerance = Math.max(50, pathLen * 0.35);
  if (bestDist > tolerance) return null;

  return bestCL.map(p => ({ x: p.x + roi.x, y: p.y + roi.y }));
}

/**
 * Automatically detect roots inside the ROI.
 *
 * Strategy:
 * 1. Make a single SAM call with a grid of foreground points → get 3 masks.
 * 2. For EACH mask, extract connected components (independent surfaces).
 * 3. Pool ALL components from all 3 masks together.
 * 4. Cluster them by area: find the largest group of similarly-sized components
 *    (sliding window where max/min ratio ≤ 5×).
 * 5. Deduplicate spatially (overlapping bbox = same root from different masks).
 * 6. Each resulting component = one root → extract its centerline as a measurement.
 *
 * Returns an array of centerline paths in **full-image** coordinates.
 */
export async function autoDetectRoots(
  imageId: string,
  roi: ROIRegion,
  onProgress?: (pct: number, msg: string) => void,
): Promise<DrawingPoint[][]> {
  if (!getCachedEmbeddings(imageId) || !model || !processor) {
    throw new Error('Embeddings no calculados');
  }

  const roiW = Math.round(roi.width);
  const roiH = Math.round(roi.height);

  onProgress?.(5, 'Obteniendo máscaras de SAM…');

  /* Grid of foreground points across ROI */
  const numCols = Math.max(3, Math.min(8, Math.round(roiW / 60)));
  const numRows = Math.max(3, Math.min(6, Math.round(roiH / 80)));
  const fg: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      fg.push({
        x: roiW * (c + 1) / (numCols + 1),
        y: roiH * (r + 1) / (numRows + 1),
      });
    }
  }
  const bgCorners = [
    { x: 2, y: 2 }, { x: roiW - 3, y: 2 },
    { x: 2, y: roiH - 3 }, { x: roiW - 3, y: roiH - 3 },
  ];

  const res = await samDecodePoints(imageId, fg, bgCorners);
  if (!res) { onProgress?.(100, 'No se obtuvo máscara'); return []; }

  onProgress?.(30, 'Extrayendo componentes de las 3 máscaras…');
  await new Promise(r => setTimeout(r, 0));

  /* Pool components from ALL masks and cluster by area */
  const totalPx = res.height * res.width;
  const { components: rootComps, maskSources, rawPerMask } = findBestRootCluster(res.allMasks, totalPx);

  console.log(`[SAM] auto-detect: ${rootComps.length} roots from masks [${[...new Set(maskSources)].join(',')}]`);

  onProgress?.(60, `Encontrados ${rootComps.length} componentes raíz`);

  /* Debug visualization — show full pipeline: raw per-mask → final */
  if (isDebugEnabled()) {
    try {
      const { debugVisualizeExtraction } = await import('./samDebugVisualizer');
      debugVisualizeExtraction({
        roiWidth: roiW,
        roiHeight: roiH,
        maskH: res.height,
        maskW: res.width,
        rawPerMask,
        finalComponents: rootComps,
        roiImageUrl: getDebugROIImageUrl() ?? undefined,
      });
    } catch (e) { console.warn('[SAM Debug] viz error:', e); }
  }

  onProgress?.(80, 'Extrayendo líneas centrales…');

  /* Extract centerline for each root component */
  const centerlines: DrawingPoint[][] = [];
  for (const comp of rootComps) {
    const cl = maskToCenterline(comp.mask, roi.x, roi.y);
    if (cl.length >= 2) centerlines.push(cl);
  }

  onProgress?.(100, `Detectadas ${centerlines.length} raíces`);
  return centerlines;
}
