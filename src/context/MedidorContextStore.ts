import { createContext } from 'react';
import type { LoadedImage, DrawingLine, ImageCalibration, ROIRegion } from '../types';

export interface MedidorContextType {
  images: LoadedImage[];
  currentImageId: string | null;
  addImages: (files: File[], maxDim?: number | null) => Promise<void>;
  removeImage: (imageId: string) => void;
  setCurrentImage: (imageId: string) => void;
  addMeasurement: (imageId: string, line: DrawingLine) => void;
  updateCalibration: (imageId: string, calibration: ImageCalibration) => void;
  removeMeasurement: (imageId: string, lineId: string) => void;
  clearAllMeasurements: () => void;
  getCurrentImage: () => LoadedImage | undefined;
  setImages: React.Dispatch<React.SetStateAction<LoadedImage[]>>;
  updateSamROI: (imageId: string, roi: ROIRegion | undefined) => void;
  renameImage: (imageId: string, newName: string) => void;
}

export const MedidorContext = createContext<MedidorContextType | undefined>(undefined);
