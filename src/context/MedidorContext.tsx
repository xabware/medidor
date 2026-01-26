import React, { createContext, useContext, useState, useCallback } from 'react';
import type { LoadedImage, DrawingLine, ImageCalibration, CropRegion, InstanceSegment } from '../types';
import { generateId } from '../utils/drawing';

interface MedidorContextType {
  images: LoadedImage[];
  currentImageId: string | null;
  addImages: (files: File[]) => Promise<void>;
  removeImage: (imageId: string) => void;
  setCurrentImage: (imageId: string) => void;
  addMeasurement: (imageId: string, line: DrawingLine) => void;
  updateCalibration: (imageId: string, calibration: ImageCalibration) => void;
  updateCrop: (imageId: string, crop: CropRegion) => void;
  removeMeasurement: (imageId: string, lineId: string) => void;
  clearAllMeasurements: () => void;
  getCurrentImage: () => LoadedImage | undefined;
  setImages: React.Dispatch<React.SetStateAction<LoadedImage[]>>;
  // Instance segmentation methods
  addInstances: (imageId: string, instances: InstanceSegment[]) => void;
  removeInstance: (imageId: string, instanceId: string) => void;
  clearInstances: (imageId: string) => void;
  updateInstanceMeasurement: (imageId: string, instanceId: string, measurement: DrawingLine) => void;
}

const MedidorContext = createContext<MedidorContextType | undefined>(undefined);

export const MedidorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [images, setImages] = useState<LoadedImage[]>([]);
  const [currentImageId, setCurrentImageId] = useState<string | null>(null);

  const addImages = useCallback(async (files: File[]) => {
    const newImages: LoadedImage[] = [];

    for (const file of files) {
      const id = generateId();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = dataUrl;
      });

      newImages.push({
        id,
        file,
        dataUrl,
        width: img.width,
        height: img.height,
        measurements: [],
        timestamp: Date.now(),
      });
    }

    setImages((prev) => [...prev, ...newImages]);
    if (newImages.length > 0 && !currentImageId) {
      setCurrentImageId(newImages[0].id);
    }
  }, [currentImageId]);

  const removeImage = useCallback((imageId: string) => {
    setImages((prev) => prev.filter((img) => img.id !== imageId));
    if (currentImageId === imageId) {
      const remaining = images.filter((img) => img.id !== imageId);
      setCurrentImageId(remaining.length > 0 ? remaining[0].id : null);
    }
  }, [currentImageId, images]);

  const addMeasurement = useCallback((imageId: string, line: DrawingLine) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? { ...img, measurements: [...img.measurements, line] }
          : img
      )
    );
  }, []);

  const updateCalibration = useCallback((imageId: string, calibration: ImageCalibration) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? { ...img, calibration }
          : img
      )
    );
  }, []);

  const updateCrop = useCallback((imageId: string, crop: CropRegion) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? { ...img, crop }
          : img
      )
    );
  }, []);

  const removeMeasurement = useCallback((imageId: string, lineId: string) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? {
              ...img,
              measurements: img.measurements.filter((m) => m.id !== lineId),
            }
          : img
      )
    );
  }, []);

  const clearAllMeasurements = useCallback(() => {
    setImages((prev) =>
      prev.map((img) => ({
        ...img,
        measurements: [],
      }))
    );
  }, []);

  const getCurrentImage = useCallback(
    () => images.find((img) => img.id === currentImageId),
    [images, currentImageId]
  );

  // Instance segmentation methods
  const addInstances = useCallback((imageId: string, instances: InstanceSegment[]) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? { ...img, instances }
          : img
      )
    );
  }, []);

  const removeInstance = useCallback((imageId: string, instanceId: string) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? {
              ...img,
              instances: img.instances?.filter((inst) => inst.id !== instanceId),
              measurements: img.measurements.filter((m) => m.instanceId !== instanceId),
            }
          : img
      )
    );
  }, []);

  const clearInstances = useCallback((imageId: string) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? {
              ...img,
              instances: [],
              measurements: img.measurements.filter((m) => m.type !== 'instance'),
            }
          : img
      )
    );
  }, []);

  const updateInstanceMeasurement = useCallback((imageId: string, instanceId: string, measurement: DrawingLine) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? {
              ...img,
              instances: img.instances?.map((inst) =>
                inst.id === instanceId
                  ? { ...inst, measurement }
                  : inst
              ),
              measurements: [
                ...img.measurements.filter((m) => m.instanceId !== instanceId),
                measurement,
              ],
            }
          : img
      )
    );
  }, []);

  const value: MedidorContextType = {
    images,
    currentImageId,
    addImages,
    removeImage,
    setCurrentImage: setCurrentImageId,
    addMeasurement,
    updateCalibration,
    updateCrop,
    removeMeasurement,
    clearAllMeasurements,
    getCurrentImage,
    setImages,
    addInstances,
    removeInstance,
    clearInstances,
    updateInstanceMeasurement,
  };

  return (
    <MedidorContext.Provider value={value}>
      {children}
    </MedidorContext.Provider>
  );
};

export const useMedidor = () => {
  const context = useContext(MedidorContext);
  if (!context) {
    throw new Error('useMedidor must be used within MedidorProvider');
  }
  return context;
};
