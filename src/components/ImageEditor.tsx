import React, { useRef, useEffect, useState } from 'react';
import { useMedidor } from '../context/MedidorContext';
import type { DrawingPoint, DrawingLine } from '../types';
import { calculateTotalDistance, drawLine, generateId } from '../utils/drawing';
import { detectRoots, drawHistogram, type HistogramData } from '../utils/rootDetection';
import styles from './ImageEditor.module.css';

interface ImageEditorProps {
  isCalibrationMode: boolean;
  onCalibrationComplete: () => void;
  calibrationUnit: string;
}

export const ImageEditor: React.FC<ImageEditorProps> = ({ 
  isCalibrationMode, 
  onCalibrationComplete,
  calibrationUnit 
}) => {
  const { getCurrentImage, addMeasurement, updateCalibration } = useMedidor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const histogramCanvasRef = useRef<HTMLCanvasElement>(null);
  const thresholdCanvasRef = useRef<HTMLCanvasElement>(null);
  const edgesCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<DrawingPoint[]>([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [thresholds, setThresholds] = useState<{ min: number; max: number } | null>(null);
  const [thresholdedImage, setThresholdedImage] = useState<ImageData | null>(null);
  const [edgesImage, setEdgesImage] = useState<ImageData | null>(null);
  const [detectedLines, setDetectedLines] = useState<Array<{ points: Array<{ x: number; y: number }> }>>([]);
  // View transform state (zoom & pan)
  const [viewScale, setViewScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const currentImage = getCurrentImage();

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Reset zoom with 'R' key
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setViewScale(1);
        setOffsetX(0);
        setOffsetY(0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Redraw canvas
  useEffect(() => {
    if (!canvasRef.current || !currentImage) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to image intrinsic size
    canvas.width = currentImage.width;
    canvas.height = currentImage.height;

    // Draw image
    const img = new Image();
    img.onload = () => {
      // Clear and apply view transform
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(viewScale, 0, 0, viewScale, offsetX, offsetY);

      ctx.drawImage(img, 0, 0);

      // Draw measurements (lines only) + labels
      currentImage.measurements.forEach((measurement: DrawingLine, idx: number) => {
        if (measurement.type === 'measurement') {
          drawLine(ctx, measurement.points, '#FF0000', 2);

          // Compute a simple centroid for label placement
          if (measurement.points.length > 0) {
            let sx = 0;
            let sy = 0;
            for (const p of measurement.points) {
              sx += p.x;
              sy += p.y;
            }
            const cx = sx / measurement.points.length;
            const cy = sy / measurement.points.length;

            const label = String(idx + 1);
            ctx.save();
            // Text style (draw with outline for contrast)
            ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 4;
            ctx.strokeStyle = 'white';
            ctx.fillStyle = '#111';
            ctx.strokeText(label, cx + 6, cy - 6);
            ctx.fillText(label, cx + 6, cy - 6);
            ctx.restore();
          }
        }
      });

      // Draw detected lines (in cyan/magenta to differentiate from manual measurements)
      if (detectedLines && detectedLines.length > 0) {
        detectedLines.forEach((line, idx) => {
          drawLine(ctx, line.points, '#00FFFF', 2);
          
          // Label for detected lines
          if (line.points.length > 0) {
            const cx = line.points[0].x;
            const cy = line.points[0].y;
            const label = `R${idx + 1}`;
            ctx.save();
            ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'black';
            ctx.fillStyle = '#00FFFF';
            ctx.strokeText(label, cx + 6, cy - 6);
            ctx.fillText(label, cx + 6, cy - 6);
            ctx.restore();
          }
        });
      }

      // Draw calibration line if exists (line only)
      if (currentImage.calibration?.calibrationLine) {
        drawLine(ctx, currentImage.calibration.calibrationLine.points, '#00FF00', 3);
      }

      // Draw current drawing (no points)
      if (currentPoints.length > 0) {
        const color = isCalibrationMode ? '#0000FF' : '#FF0000';
        drawLine(ctx, currentPoints, color, 2);
      }
    };
    img.src = currentImage.dataUrl;
  }, [currentImage, currentPoints, isCalibrationMode, viewScale, offsetX, offsetY, detectedLines]);

  // Reset view when image changes (defer to next frame)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setViewScale(1);
      setOffsetX(0);
      setOffsetY(0);
    });
    return () => cancelAnimationFrame(raf);
  }, [currentImage?.id]);

  // Helpers to get positions
  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  };

  const toImageCoords = (x: number, y: number) => {
    return {
      x: (x - offsetX) / viewScale,
      y: (y - offsetY) / viewScale,
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !currentImage) return;

    const { x, y } = getCanvasCoords(e);
    const p = toImageCoords(x, y);
    const newPoint = { x: p.x, y: p.y };

    // Ambos modos: iniciar arrastre
    setIsDrawing(true);
    setCurrentPoints([newPoint]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !canvasRef.current) return;

    const { x, y } = getCanvasCoords(e);
    const p = toImageCoords(x, y);
    const newPoint = { x: p.x, y: p.y };

    if (isCalibrationMode) {
      // En modo calibración, mostrar una línea recta desde el inicio hasta la posición actual
      setCurrentPoints([currentPoints[0], newPoint]);
    } else {
      // En modo medición, agregar puntos para dibujar curva
      setCurrentPoints((prev) => [...prev, newPoint]);
    }
  };

  const handleMouseUp = () => {
    if (!isDrawing || !currentImage) return;
    setIsDrawing(false);

    if (currentPoints.length < 2) {
      setCurrentPoints([]);
      return;
    }

    if (isCalibrationMode) {
      // Guardar la línea recta de calibración y pedir longitud real
      const pixelLength = calculateTotalDistance(currentPoints);
      const calibrationLine: DrawingLine = {
        id: generateId(),
        points: currentPoints,
        imageId: currentImage.id,
        type: 'calibration',
        pixelLength,
        timestamp: Date.now(),
      };

      // Pedir la longitud real
      const realLengthInput = prompt(
        `Línea de calibración: ${pixelLength.toFixed(2)} píxeles\n\n` +
        `Ingresa la longitud real de esta línea (en ${calibrationUnit}):`
      );

      if (realLengthInput) {
        const realLength = parseFloat(realLengthInput);
        if (!isNaN(realLength) && realLength > 0) {
          const pixelsPerUnit = pixelLength / realLength;
          const now = Date.now();

          updateCalibration(currentImage.id, {
            imageId: currentImage.id,
            calibrationLine,
            pixelsPerUnit,
            timestamp: now,
          });

          // Volver al modo normal
          onCalibrationComplete();
        } else {
          alert('Longitud inválida. Por favor, intenta de nuevo.');
        }
      }
    } else {
      // Guardar medición
      const pixelLength = calculateTotalDistance(currentPoints);
      const measurement: DrawingLine = {
        id: generateId(),
        points: currentPoints,
        imageId: currentImage.id,
        type: 'measurement',
        pixelLength,
        timestamp: Date.now(),
      };

      // No guardamos realLength, se calculará dinámicamente desde pixelsPerUnit
      addMeasurement(currentImage.id, measurement);
    }

    setCurrentPoints([]);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    e.preventDefault();

    const zoomIntensity = 0.0015; // smaller = slower zoom
    const scaleFactor = Math.exp(-e.deltaY * zoomIntensity);
    const newScale = Math.min(10, Math.max(0.1, viewScale * scaleFactor));

    // Get mouse position in canvas pixels
    const { x, y } = getCanvasCoords(e as unknown as React.MouseEvent<HTMLCanvasElement>);

    // Compute world (image) coords before zoom
    const wx = (x - offsetX) / viewScale;
    const wy = (y - offsetY) / viewScale;

    // Compute new offset so the point under cursor stays fixed
    const newOffsetX = x - wx * newScale;
    const newOffsetY = y - wy * newScale;

    setViewScale(newScale);
    setOffsetX(newOffsetX);
    setOffsetY(newOffsetY);
  };

  const handleResetView = () => {
    setViewScale(1);
    setOffsetX(0);
    setOffsetY(0);
  };

  const handleAutoDetect = async () => {
    if (!canvasRef.current || !currentImage || isDetecting) return;
    
    setIsDetecting(true);
    try {
      // Crear un canvas temporal con la imagen sin transformaciones
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = currentImage.width;
      tempCanvas.height = currentImage.height;
      const tempCtx = tempCanvas.getContext('2d');
      
      if (!tempCtx) throw new Error('No se pudo crear canvas temporal');
      
      // Cargar y dibujar la imagen original
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          tempCtx.drawImage(img, 0, 0);
          resolve();
        };
        img.onerror = reject;
        img.src = currentImage.dataUrl;
      });
      
      const result = await detectRoots(tempCanvas, (msg: string) => {
        console.log('Progreso:', msg);
      });
      
      console.log('Resultado de detección:', {
        linesCount: result.lines.length,
        lines: result.lines,
        firstLinePoints: result.lines[0]?.points?.length || 0
      });
      
      setHistogram(result.histogram);
      setThresholds(result.thresholds);
      setThresholdedImage(result.thresholdedImage);
      setEdgesImage(result.edgesImage);
      setDetectedLines(result.lines);
      console.log('Detección completada:', result);
    } catch (error) {
      console.error('Error en detección:', error);
      alert('Error al analizar la imagen');
    } finally {
      setIsDetecting(false);
    }
  };

  const handleCloseHistogram = () => {
    setHistogram(null);
    setThresholds(null);
    setThresholdedImage(null);
    setEdgesImage(null);
    setDetectedLines([]);
  };

  const handleAddDetectedMeasurements = () => {
    if (!detectedLines || detectedLines.length === 0 || !currentImage) return;

    const nRootsInput = window.prompt('¿Cuántas raíces hay en la imagen? (solo se agregarán los N trazos más largos)', String(detectedLines.length));
    if (!nRootsInput) return;
    const nRoots = Math.max(1, Math.min(detectedLines.length, parseInt(nRootsInput)));

    // Ordenar por longitud descendente
    const sortedLines = [...detectedLines].sort((a, b) => calculateTotalDistance(b.points) - calculateTotalDistance(a.points));
    const selected = sortedLines.slice(0, nRoots);

    selected.forEach(line => {
      if (line.points.length > 1) {
        addMeasurement(currentImage.id, {
          id: generateId(),
          imageId: currentImage.id,
          type: 'measurement',
          points: line.points,
          pixelLength: calculateTotalDistance(line.points),
          timestamp: Date.now()
        });
      }
    });

    handleCloseHistogram();
    alert(`Se agregaron ${selected.length} mediciones (las ${selected.length} raíces más largas)`);
  };

  // Dibujar histograma cuando cambie
  useEffect(() => {
    if (histogram && histogramCanvasRef.current) {
      const ctx = histogramCanvasRef.current.getContext('2d');
      if (ctx) {
        drawHistogram(ctx, histogram, 256, 150, thresholds || undefined);
      }
    }
  }, [histogram, thresholds]);

  // Dibujar imagen umbralizada cuando cambie
  useEffect(() => {
    if (thresholdedImage && thresholdCanvasRef.current) {
      const canvas = thresholdCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = thresholdedImage.width;
        canvas.height = thresholdedImage.height;
        ctx.putImageData(thresholdedImage, 0, 0);
      }
    }
  }, [thresholdedImage]);

  // Dibujar imagen de bordes cuando cambie
  useEffect(() => {
    if (edgesImage && edgesCanvasRef.current) {
      const canvas = edgesCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = edgesImage.width;
        canvas.height = edgesImage.height;
        ctx.putImageData(edgesImage, 0, 0);
      }
    }
  }, [edgesImage]);

  if (!currentImage) {
    return <div className={styles.editorPlaceholder}>Carga una imagen para comenzar</div>;
  }

  return (
    <div className={styles.editor}>
      {isCalibrationMode && (
        <div className={styles.calibrationBanner}>
          📏 Modo calibración: Arrastra en el canvas para dibujar la línea de calibración
        </div>
      )}
      <div className={styles.toolbar}>
        <button className={styles.toolbarButton} onClick={handleResetView} title="Restablecer vista (zoom/pan) - Atajo: R">
          Restablecer zoom
        </button>
        <span className={styles.zoomInfo}>{Math.round(viewScale * 100)}%</span>
        <div style={{ flex: 1 }}></div>
        <button 
          className={styles.toolbarButton} 
          onClick={handleAutoDetect}
          disabled={isDetecting || isCalibrationMode}
          title="Detectar raíces automáticamente"
        >
          {isDetecting ? '⏳ Analizando...' : '🔍 Detectar raíces'}
        </button>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{ cursor: isCalibrationMode ? 'crosshair' : (isDrawing ? 'crosshair' : 'pointer') }}
        />
      </div>
      
      {histogram && detectedLines && detectedLines.length > 0 && (
        <div className={styles.histogramOverlay}>
          <div className={styles.histogramPanel}>
            <div className={styles.histogramHeader}>
              <h3>Raíces detectadas</h3>
              <button 
                className={styles.closeButton} 
                onClick={handleCloseHistogram}
                title="Cerrar"
              >
                ✕
              </button>
            </div>
            <div className={styles.analysisGrid}>
              <div className={styles.analysisSection}>
                <h4>Líneas detectadas: {detectedLines.length}</h4>
                <p className={styles.histogramInfo}>
                  Se han detectado {detectedLines.length} raíces. Solo se agregarán las más largas según el número que indiques.
                </p>
                <button 
                  className={styles.addMeasurementsButton}
                  onClick={handleAddDetectedMeasurements}
                >
                  ✓ Agregar como mediciones
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
