export interface DrawingPoint {
  x: number;
  y: number;
}

export interface DrawingLine {
  id: string;
  points: DrawingPoint[];
  imageId: string;
  type: 'measurement' | 'calibration';
  pixelLength?: number;
  realLength?: number;
  timestamp: number;
}

export interface ImageCalibration {
  imageId: string;
  calibrationLine?: DrawingLine;
  pixelsPerUnit?: number;
  timestamp: number;
}

/** Axis-aligned region of interest (image-space coords). */
export interface ROIRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LoadedImage {
  id: string;
  file: File;
  dataUrl: string;
  width: number;
  height: number;
  measurements: DrawingLine[];
  calibration?: ImageCalibration;
  timestamp: number;
  /** Custom display name (overrides file.name when set) */
  displayName?: string;
  embeddingsModelId?: string;
  samROI?: ROIRegion;
  originalDataUrl?: string;
  originalWidth?: number;
  originalHeight?: number;
}
