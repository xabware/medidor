import React from 'react';
import { useMedidor } from '../context/MedidorContext';
import { downloadCSV } from '../utils/drawing';
import type { LoadedImage, DrawingLine } from '../types';
import styles from './MeasurementsPanel.module.css';

interface MeasurementsPanelProps {
  calibrationUnit: string;
}

export const MeasurementsPanel: React.FC<MeasurementsPanelProps> = ({ calibrationUnit }) => {
  const { images, getCurrentImage, removeMeasurement, clearAllMeasurements } = useMedidor();
  const currentImage = getCurrentImage();

  const handleExportCSV = () => {
    const data: Record<string, string | number>[] = [];

    // Encontrar el número máximo de mediciones
    let maxMeasurements = 0;
    images.forEach((image: LoadedImage) => {
      if (image.measurements.length > maxMeasurements) {
        maxMeasurements = image.measurements.length;
      }
    });

    images.forEach((image: LoadedImage) => {
      const pixelsPerUnit = image.calibration?.pixelsPerUnit || 1;
      
      const row: Record<string, string | number> = {
        imageFileName: image.file.name,
      };

      // Agregar todas las columnas de mediciones (incluso si están vacías)
      for (let i = 0; i < maxMeasurements; i++) {
        const measurement = image.measurements[i];
        if (measurement) {
          const realLength = measurement.pixelLength ? measurement.pixelLength / pixelsPerUnit : 0;
          row[`medicion_${i + 1}`] = parseFloat(realLength.toFixed(2));
        } else {
          row[`medicion_${i + 1}`] = '';
        }
      }

      data.push(row);
    });

    if (data.length === 0) {
      alert('No hay mediciones para exportar');
      return;
    }

    downloadCSV(data, `mediciones_${new Date().getTime()}.csv`);
  };

  const handleClearAllMeasurements = () => {
    if (confirm('¿Estás seguro de que deseas eliminar todas las mediciones?')) {
      clearAllMeasurements();
    }
  };

  return (
    <div className={styles.panel}>
      <h2>Mediciones</h2>
      
      {currentImage && (
        <div className={styles.measurements}>
          <h3>Imagen actual ({currentImage.measurements.length})</h3>
          <ul>
            {currentImage.measurements.map((measurement: DrawingLine, idx: number) => {
              const pixelsPerUnit = currentImage.calibration?.pixelsPerUnit || 1;
              const realLength = measurement.pixelLength ? measurement.pixelLength / pixelsPerUnit : 0;
              
              return (
                <li key={measurement.id}>
                  <span>
                    Línea {idx + 1}: {measurement.pixelLength?.toFixed(2)} px
                    {currentImage.calibration?.pixelsPerUnit && ` → ${realLength.toFixed(2)} ${calibrationUnit}`}
                  </span>
                  <button
                    className={styles.deleteBtn}
                    onClick={() => removeMeasurement(currentImage.id, measurement.id)}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          {currentImage.measurements.length === 0 && (
            <p className={styles.emptyMessage}>No hay mediciones en esta imagen</p>
          )}
        </div>
      )}

      <div className={styles.section}>
        <h3>Exportar datos</h3>
        <button className={`${styles.btn} ${styles.exportBtn}`} onClick={handleExportCSV}>
          📥 Descargar CSV
        </button>
        <p className={styles.hint}>
          Total de mediciones: <strong>{images.reduce((acc: number, img: LoadedImage) => acc + img.measurements.length, 0)}</strong>
        </p>
      </div>

      <div className={styles.section}>
        <button className={`${styles.btn} ${styles.clearBtn}`} onClick={handleClearAllMeasurements}>
          🗑 Limpiar todo
        </button>
      </div>
    </div>
  );
};
