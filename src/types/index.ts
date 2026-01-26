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
  type: 'measurement' | 'calibration' | 'instance';
  pixelLength?: number;
  realLength?: number;
  timestamp: number;
  instanceId?: string; // Link to instance segment
}

export interface InstanceSegment {
  id: string;
  imageId: string;
  mask: Uint8ClampedArray;
  width: number;
  height: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  area: number;
  centroid: DrawingPoint;
  confidence: number;
  color: string;
  measurement?: DrawingLine; // Associated measurement line
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
  instances?: InstanceSegment[]; // Segmented root instances
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
