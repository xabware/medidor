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

/** A straight reference line drawn during calibration (2 endpoints). */
export interface CalibrationRefLine {
  start: DrawingPoint;
  end: DrawingPoint;
  /** Real-world length in calibrationUnit */
  realLength: number;
  /** Pixel length of the original line before any normalisation */
  pixelLength: number;
}

export interface ImageCalibration {
  imageId: string;
  /** Calibration mode: 'line' (2-point, no normalization) or 'rect' (4-corner perspective) */
  mode: 'line' | 'rect';
  /** The 4 corners of the reference rectangle in source image space [TL, TR, BR, BL] (rect mode) */
  corners?: [DrawingPoint, DrawingPoint, DrawingPoint, DrawingPoint];
  /** The 2 endpoints of the reference line (line mode) */
  linePoints?: [DrawingPoint, DrawingPoint];
  realWidth: number;
  realHeight: number;
  pixelsPerUnitX: number;
  pixelsPerUnitY: number;
  /** Whether the image was perspective-corrected */
  wasNormalized: boolean;
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
