import React, { useRef, useState, useCallback } from 'react';
import { useMedidor } from '../context/MedidorContext';
import type { LoadedImage } from '../types';
import styles from './ImageLoader.module.css';

interface ImageLoaderProps {
  onStartCalibration: () => void;
  onCancelCalibration: () => void;
  isCalibrationMode: boolean;
  calibrationUnit: string;
}

export const ImageLoader: React.FC<ImageLoaderProps> = ({ 
  onStartCalibration, 
  onCancelCalibration,
  isCalibrationMode,
  calibrationUnit 
}) => {
  const { images, addImages, removeImage, setCurrentImage, currentImageId } = useMedidor();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      await addImages(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCalibrateClick = (imageId: string) => {
    if (isCalibrationMode) {
      // Si ya está en modo calibración, cancelar
      onCancelCalibration();
    } else {
      // Si no está en modo calibración, activarlo
      setCurrentImage(imageId);
      onStartCalibration();
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  }, [isDragging]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Only reset when leaving the dropzone, not when entering child
    if ((e.target as HTMLElement).classList.contains(styles.dropzone)) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files || []);
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      await addImages(imageFiles);
    }
  }, [addImages]);

  return (
    <div className={styles.loader}>
      <h2>Imágenes</h2>

      <div className={styles.uploadSection}>
        <div
          className={`${styles.dropzone} ${isDragging ? styles.dropzoneActive : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
          aria-label="Arrastra imágenes o haz clic para seleccionarlas"
        >
          <div className={styles.dropzoneIcon}>📷</div>
          <div className={styles.dropzoneText}>
            Arrastra y suelta imágenes aquí<br />
            <span className={styles.dropzoneSubtext}>o haz clic para seleccionar archivos</span>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      <div className={styles.imageList}>
        {images.length === 0 ? (
          <p className={styles.emptyMessage}>No hay imágenes cargadas</p>
        ) : (
          images.map((image: LoadedImage) => (
            <div
              key={image.id}
              className={`${styles.imageItem} ${currentImageId === image.id ? styles.active : ''}`}
            >
              <div 
                className={styles.imageContent}
                onClick={() => setCurrentImage(image.id)}
              >
                <img src={image.dataUrl} alt="thumbnail" className={styles.thumbnail} />
                <div className={styles.imageInfo}>
                  <p className={styles.fileName}>{image.file.name}</p>
                  <p className={styles.fileSize}>{(image.file.size / 1024).toFixed(1)} KB</p>
                  <p className={styles.dimensions}>{image.width} × {image.height}</p>
                  {image.calibration?.pixelsPerUnit && (
                    <p className={styles.calibrationInfo}>
                      📏 {image.calibration.pixelsPerUnit.toFixed(2)} px/{calibrationUnit}
                    </p>
                  )}
                </div>
              </div>
              <div className={styles.actions}>
                <button
                  className={`${styles.calibrateBtn} ${isCalibrationMode && currentImageId === image.id ? styles.active : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCalibrateClick(image.id);
                  }}
                  title={isCalibrationMode && currentImageId === image.id ? 'Cancelar calibración' : (image.calibration?.pixelsPerUnit ? 'Recalibrar' : 'Calibrar')}
                >
                  {image.calibration?.pixelsPerUnit ? '🔄' : '📏'}
                </button>
                <button
                  className={styles.removeBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeImage(image.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
