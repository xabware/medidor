import React, { useRef, useState, useCallback } from 'react';
import { useMedidor } from '../context/useMedidor';
import type { LoadedImage } from '../types';
import styles from './ImageLoader.module.css';

interface ImageLoaderProps {
  onStartCalibration: () => void;
  onCancelCalibration: () => void;
  isCalibrationMode: boolean;
  calibrationUnit: string;
  samModelId: string | null;
  maxResolution: number | null;
  isROIMode: boolean;
  onStartROI: () => void;
}

export const ImageLoader: React.FC<ImageLoaderProps> = ({ 
  onStartCalibration, 
  onCancelCalibration,
  isCalibrationMode,
  calibrationUnit,
  samModelId,
  maxResolution,
  isROIMode,
  onStartROI,
}) => {
  const { images, addImages, removeImage, setCurrentImage, currentImageId, renameImage } = useMedidor();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [editingImageId, setEditingImageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      await addImages(files, maxResolution);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCalibrateClick = (imageId: string) => {
    if (isCalibrationMode) {
      onCancelCalibration();
    } else {
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
      await addImages(imageFiles, maxResolution);
    }
  }, [addImages, maxResolution]);

  // Enter ROI selection mode for an image
  const handleDefineROI = useCallback((image: LoadedImage) => {
    if (!samModelId || isROIMode) return;
    setCurrentImage(image.id);
    onStartROI();
  }, [samModelId, isROIMode, setCurrentImage, onStartROI]);

  // Inline rename
  const startEditing = (image: LoadedImage) => {
    setEditingImageId(image.id);
    setEditValue(image.displayName ?? image.file.name);
  };

  const commitRename = () => {
    if (editingImageId && editValue.trim()) {
      renameImage(editingImageId, editValue);
    }
    setEditingImageId(null);
  };

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
          images.map((image: LoadedImage) => {
            const embReady = !!(image.embeddingsModelId && image.embeddingsModelId === samModelId);
            const embStale = !!(image.embeddingsModelId && image.embeddingsModelId !== samModelId);
            const isCompressed = !!image.originalDataUrl;

            return (
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
                  {editingImageId === image.id ? (
                    <input
                      className={styles.renameInput}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditingImageId(null);
                      }}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className={styles.fileNameRow}>
                      <p className={styles.fileName}>
                        {image.displayName ?? image.file.name}
                        {embReady && <span className={`${styles.badge} ${styles.badgeAI}`}>🧠 IA</span>}
                        {embStale && <span className={`${styles.badge} ${styles.badgeStale}`}>🧠 ⚠</span>}
                        {image.samROI && <span className={`${styles.badge} ${styles.badgeAI}`}>🔲 ROI</span>}
                      </p>
                      <button
                        className={styles.editNameBtn}
                        onClick={(e) => { e.stopPropagation(); startEditing(image); }}
                        title="Renombrar imagen"
                      >
                        ✏️
                      </button>
                    </div>
                  )}
                  <p className={styles.fileSize}>{(image.file.size / 1024).toFixed(1)} KB</p>
                  <p className={styles.dimensions}>
                    {isCompressed ? `${image.originalWidth}×${image.originalHeight} → ` : ''}
                    {image.width} × {image.height}
                  </p>
                  {image.calibration?.pixelsPerUnit && (
                    <p className={styles.calibrationInfo}>
                      📏 {image.calibration.pixelsPerUnit.toFixed(2)} px/{calibrationUnit}
                    </p>
                  )}
                </div>
              </div>
              <div className={styles.actions}>
                {/* ROI define/redefine button */}
                <button
                  className={`${styles.aiBtn} ${image.samROI ? styles.ready : ''}`}
                  onClick={(e) => { e.stopPropagation(); handleDefineROI(image); }}
                  disabled={!samModelId || isROIMode}
                  title={
                    !samModelId
                      ? 'Carga un modelo SAM en la barra superior primero'
                      : image.samROI
                        ? 'Redefinir ROI'
                        : 'Definir ROI'
                  }
                >
                  🔲
                </button>
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
              {/* Embeddings progress bar */}
            </div>
            );
          })
        )}
      </div>
    </div>
  );
};
