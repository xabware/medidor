export interface DrawingPoint {
  x: number;
  y: number;
}

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  croppedDataUrl: string;
  timestamp: number;
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

export interface LoadedImage {
  id: string;
  file: File;
  dataUrl: string;
  width: number;
  height: number;
  measurements: DrawingLine[];
  calibration?: ImageCalibration;
  crop?: CropRegion;
  timestamp: number;
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
