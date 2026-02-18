/**
 * SAM (Segment Anything Model) integration for interactive root segmentation.
 * Uses @huggingface/transformers to run SAM inference in the browser.
 *
 * Flow:
 *   1. loadSAMModel(modelId)       – download & init (once per model choice)
 *   2. getOrComputeEmbeddings(id, url) – heavy encoder pass (cached per image)
 *   3. segmentAndMeasure(emb, pt)  – lightweight decoder per click
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Enable ONNX WASM proxy mode ─────────────────────────────────
// This runs WASM inference in a background Web Worker, preventing
// the main thread from blocking (especially critical for large models).
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

// ── Module-level singletons ──────────────────────────────────────
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

// ── Model catalogue ──────────────────────────────────────────────
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

// ── Device detection ─────────────────────────────────────────────
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

// ── Public types ─────────────────────────────────────────────────
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

// ── Model lifecycle ──────────────────────────────────────────────

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

// ── Embeddings ───────────────────────────────────────────────────

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

/** Return cached embeddings for the currently loaded model, or null. */
export function getCachedEmbeddings(imageId: string): SAMEmbeddings | null {
  if (!loadedModelId) return null;
  return embeddingsCache.get(`${loadedModelId}::${imageId}`) ?? null;
}

/** Check if embeddings are cached for a given image + currently loaded model. */
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
