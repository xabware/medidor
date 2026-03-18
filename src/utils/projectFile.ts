/**
 * Save / Load `.raiz` project files.
 * Serialises images (data-URLs, measurements, calibrations, ROIs) to JSON.
 * Embeddings tensors are NOT saved — only the embeddingsModelId flag.
 *
 * Version history:
 *   v1 — Original format (calibration: { calibrationLine, pixelsPerUnit })
 *   v2 — Current format  (calibration: { mode, corners, linePoints, realWidth,
 *         realHeight, pixelsPerUnitX, pixelsPerUnitY, wasNormalized })
 *         Added displayName field.
 */

import type { LoadedImage, ImageCalibration, DrawingLine, DrawingPoint } from '../types';

// ── Serialisable subset of LoadedImage ───────────────────────────
interface SerialisedImage {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  dataUrl: string;
  width: number;
  height: number;
  measurements: LoadedImage['measurements'];
  calibration?: LoadedImage['calibration'];
  timestamp: number;
  embeddingsModelId?: string;
  samROI?: LoadedImage['samROI'];
  originalDataUrl?: string;
  originalWidth?: number;
  originalHeight?: number;
  displayName?: string;
}

/** v1 calibration shape (for migration) */
interface V1Calibration {
  imageId: string;
  calibrationLine?: {
    points: DrawingPoint[];
    pixelLength?: number;
    realLength?: number;
  };
  pixelsPerUnit?: number;
  timestamp: number;
}

interface ProjectFile {
  version: number;
  createdAt: string;
  currentImageId: string | null;
  maxResolution: number | null;
  images: SerialisedImage[];
}

const CURRENT_VERSION = 2;

// ── Helpers ──────────────────────────────────────────────────────

function rehydrateFile(s: SerialisedImage): File {
  const arr = s.dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1] ?? s.fileType;
  const bstr = atob(arr[1]);
  const u8 = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
  return new File([u8], s.fileName, { type: mime });
}

/** Detect and convert a v1 calibration object to the current format. */
function migrateCalibration(
  raw: Record<string, unknown> | undefined,
  imageId: string,
): ImageCalibration | undefined {
  if (!raw) return undefined;

  // Already in v2+ format
  if ('mode' in raw && 'pixelsPerUnitX' in raw) {
    return raw as unknown as ImageCalibration;
  }

  // v1 format: { calibrationLine?, pixelsPerUnit?, timestamp }
  const v1 = raw as unknown as V1Calibration;
  const ppu = v1.pixelsPerUnit;
  if (!ppu || ppu <= 0) return undefined;

  const line = v1.calibrationLine;
  const points = line?.points;
  let linePoints: [DrawingPoint, DrawingPoint] | undefined;
  let pixelLen = 0;
  if (points && points.length >= 2) {
    const p0 = points[0];
    const p1 = points[points.length - 1];
    linePoints = [p0, p1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    pixelLen = Math.sqrt(dx * dx + dy * dy);
  }

  const realLength = pixelLen > 0 ? pixelLen / ppu : 0;

  return {
    imageId,
    mode: 'line',
    linePoints,
    realWidth: realLength,
    realHeight: realLength,
    pixelsPerUnitX: ppu,
    pixelsPerUnitY: ppu,
    wasNormalized: false,
    timestamp: v1.timestamp ?? Date.now(),
  };
}

/** Remove old `type: 'calibration'` entries from the measurements array. */
function migrateMeasurements(measurements: DrawingLine[]): DrawingLine[] {
  return measurements.filter((m) => m.type !== 'calibration');
}

// ── Public API ───────────────────────────────────────────────────

export function saveProject(
  images: LoadedImage[],
  currentImageId: string | null,
  maxResolution: number | null,
): void {
  const serialised: SerialisedImage[] = images.map((img) => ({
    id: img.id,
    fileName: img.file.name,
    fileSize: img.file.size,
    fileType: img.file.type,
    dataUrl: img.dataUrl,
    width: img.width,
    height: img.height,
    measurements: img.measurements,
    calibration: img.calibration,
    timestamp: img.timestamp,
    embeddingsModelId: img.embeddingsModelId,
    samROI: img.samROI,
    originalDataUrl: img.originalDataUrl,
    originalWidth: img.originalWidth,
    originalHeight: img.originalHeight,
    displayName: img.displayName,
  }));

  const project: ProjectFile = {
    version: CURRENT_VERSION,
    createdAt: new Date().toISOString(),
    currentImageId,
    maxResolution,
    images: serialised,
  };

  const json = JSON.stringify(project);
  const blob = new Blob([json], { type: 'application/json' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `medidor_${new Date().toISOString().slice(0, 10)}.raiz`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface LoadedProject {
  images: LoadedImage[];
  currentImageId: string | null;
  maxResolution: number | null;
}

export async function loadProject(): Promise<LoadedProject | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.raiz';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }

      try {
        const text = await file.text();
        const project: ProjectFile = JSON.parse(text);

        if (!project.version || project.version > CURRENT_VERSION) {
          alert('Versión de archivo no compatible.');
          resolve(null);
          return;
        }

        const needsMigration = project.version < CURRENT_VERSION;

        const images: LoadedImage[] = project.images.map((s) => {
          const calibration = needsMigration
            ? migrateCalibration(s.calibration as unknown as Record<string, unknown>, s.id)
            : s.calibration;

          const measurements = needsMigration
            ? migrateMeasurements(s.measurements)
            : s.measurements;

          return {
            id: s.id,
            file: rehydrateFile(s),
            dataUrl: s.dataUrl,
            width: s.width,
            height: s.height,
            measurements,
            calibration,
            timestamp: s.timestamp,
            embeddingsModelId: s.embeddingsModelId,
            samROI: s.samROI,
            originalDataUrl: s.originalDataUrl,
            originalWidth: s.originalWidth,
            originalHeight: s.originalHeight,
            displayName: s.displayName,
          };
        });

        resolve({
          images,
          currentImageId: project.currentImageId,
          maxResolution: project.maxResolution ?? null,
        });
      } catch (err) {
        console.error('Error loading .raiz file:', err);
        alert('Error al cargar el archivo .raiz');
        resolve(null);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
