import React, { useState, useCallback } from 'react';
import type { LoadedImage, DrawingLine, ImageCalibration, ROIRegion } from '../types';
import { generateId } from '../utils/drawing';
import { compressImage } from '../utils/imageCompression';
import { MedidorContext, type MedidorContextType } from './MedidorContextStore';

export const MedidorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [images, setImages] = useState<LoadedImage[]>([]);
  const [currentImageId, setCurrentImageId] = useState<string | null>(null);

  const addImages = useCallback(async (files: File[], maxDim: number | null = null) => {
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

      let finalDataUrl = dataUrl;
      let finalWidth = img.width;
      let finalHeight = img.height;
      let origDataUrl: string | undefined;
      let origWidth: number | undefined;
      let origHeight: number | undefined;

      if (maxDim && (img.width > maxDim || img.height > maxDim)) {
        origDataUrl = dataUrl;
        origWidth = img.width;
        origHeight = img.height;
        const result = await compressImage(dataUrl, maxDim);
        finalDataUrl = result.dataUrl;
        finalWidth = result.width;
        finalHeight = result.height;
      }

      newImages.push({
        id,
        file,
        dataUrl: finalDataUrl,
        width: finalWidth,
        height: finalHeight,
        measurements: [],
        timestamp: Date.now(),
        originalDataUrl: origDataUrl,
        originalWidth: origWidth,
        originalHeight: origHeight,
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

  const updateSamROI = useCallback((imageId: string, roi: ROIRegion | undefined) => {
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? { ...img, samROI: roi, embeddingsModelId: undefined }
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
    removeMeasurement,
    clearAllMeasurements,
    getCurrentImage,
    setImages,
    updateSamROI,
  };

  return (
    <MedidorContext.Provider value={value}>
      {children}
    </MedidorContext.Provider>
  );
};

