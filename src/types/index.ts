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
  /** Model ID for which embeddings have been computed */
  embeddingsModelId?: string;
  /** ROI for SAM embeddings (image-space coords) */
  samROI?: ROIRegion;
  /** Original image before auto-compression (stored for toggle restore) */
  originalDataUrl?: string;
  originalWidth?: number;
  originalHeight?: number;
}

export interface MeasurementData extends Record<string, string | number> {
  imageFileName: string;
  measurement: string;
  pixelLength: number;
  calibrationFactor: number;
  realLength: number;
  unit: string;
  timestamp: string;
}
