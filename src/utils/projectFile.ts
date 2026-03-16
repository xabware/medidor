/**
 * Save / Load `.raiz` project files.
 * Serialises images (data-URLs, measurements, calibrations, ROIs) to JSON.
 * Embeddings tensors are NOT saved — only the embeddingsModelId flag.
 */

import type { LoadedImage, ImageCalibration, DrawingLine } from '../types';

// ── Serialisable subset of LoadedImage ───────────────────────────
// `File` objects can't be serialised, so we store the essential metadata.
interface SerialisedImage {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  dataUrl: string;
  width: number;
  height: number;
  measurements: LoadedImage['measurements'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calibration?: LoadedImage['calibration'] | Record<string, any>;
  timestamp: number;
  embeddingsModelId?: string;
  samROI?: LoadedImage['samROI'];
  originalDataUrl?: string;
  originalWidth?: number;
  originalHeight?: number;
  displayName?: string;
}

interface ProjectFile {
  version: 1;
  createdAt: string;
  currentImageId: string | null;
  maxResolution: number | null;
  images: SerialisedImage[];
}

// Helpers

/**
 * Migrate old-format calibration (pre-b838177) to the current format.
 * Old format had: { calibrationLine?: DrawingLine; pixelsPerUnit?: number }
 * New format has:  { mode; pixelsPerUnitX; pixelsPerUnitY; realWidth; realHeight; wasNormalized; … }
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateCalibration(raw: Record<string, any>, imageId: string): ImageCalibration | undefined {
  // Already in new format
  if ('mode' in raw && 'pixelsPerUnitX' in raw) return raw as unknown as ImageCalibration;

  // Old format migration
  const pixelsPerUnit: number | undefined = raw.pixelsPerUnit;
  if (pixelsPerUnit == null || pixelsPerUnit <= 0) return undefined;

  const calLine = raw.calibrationLine;
  const linePoints = calLine?.points?.length >= 2
    ? [calLine.points[0], calLine.points[calLine.points.length - 1]] as [{ x: number; y: number }, { x: number; y: number }]
    : undefined;

  const pixelLength: number = calLine?.pixelLength ?? 0;
  const realLength = pixelLength > 0 ? pixelLength / pixelsPerUnit : 0;

  return {
    imageId,
    mode: 'line',
    linePoints,
    realWidth: realLength,
    realHeight: realLength,
    pixelsPerUnitX: pixelsPerUnit,
    pixelsPerUnitY: pixelsPerUnit,
    wasNormalized: false,
    timestamp: raw.timestamp ?? Date.now(),
  };
}

/** Filter out old calibration-type measurements that are no longer used. */
function filterMeasurements(measurements: DrawingLine[]): DrawingLine[] {
  return measurements.filter((m) => m.type !== 'calibration');
}

function rehydrateFile(s: SerialisedImage): File {
  // Convert data-URL to Blob so we can build a real File
  const arr = s.dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1] ?? s.fileType;
  const bstr = atob(arr[1]);
  const u8 = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
  return new File([u8], s.fileName, { type: mime });
}

// Public API

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
    version: 1,
    createdAt: new Date().toISOString(),
    currentImageId,
    maxResolution,
    images: serialised,
  };

  const json = JSON.stringify(project);
  const blob = new Blob([json], { type: 'application/json' });

  // Trigger download
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

        if (project.version !== 1) {
          alert('Versión de archivo no compatible.');
          resolve(null);
          return;
        }

        const images: LoadedImage[] = project.images.map((s) => ({
          id: s.id,
          file: rehydrateFile(s),
          dataUrl: s.dataUrl,
          width: s.width,
          height: s.height,
          measurements: filterMeasurements(s.measurements),
          calibration: s.calibration ? migrateCalibration(s.calibration as Record<string, unknown>, s.id) : undefined,
          timestamp: s.timestamp,
          embeddingsModelId: s.embeddingsModelId,
          samROI: s.samROI,
          originalDataUrl: s.originalDataUrl,
          originalWidth: s.originalWidth,
          originalHeight: s.originalHeight,
          displayName: s.displayName,
        }));

        resolve({
          images,
          currentImageId: project.currentImageId,
          maxResolution: project.maxResolution,
        });
      } catch (err) {
        console.error('Error loading .raiz file:', err);
        alert('Error al cargar el archivo .raiz');
        resolve(null);
      }
    };
    // If the user cancels the file picker
    input.oncancel = () => resolve(null);
    input.click();
  });
}
