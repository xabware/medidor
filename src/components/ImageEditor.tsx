import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useMedidor } from '../context/useMedidor';
import type { DrawingPoint, DrawingLine, ROIRegion } from '../types';
import { calculateTotalDistance, drawLine, generateId } from '../utils/drawing';
import { getOrComputeEmbeddings, getLoadedModelId } from '../utils/samSegmentation';
import styles from './ImageEditor.module.css';

/** Crop a data-URL image to the given ROI and return a new data-URL */
function cropImageToROI(dataUrl: string, roi: ROIRegion): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(roi.width);
      canvas.height = Math.round(roi.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(
        img,
        Math.round(roi.x), Math.round(roi.y),
        Math.round(roi.width), Math.round(roi.height),
        0, 0,
        canvas.width, canvas.height,
      );
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

interface ImageEditorProps {
  isCalibrationMode: boolean;
  onCalibrationComplete: () => void;
  calibrationUnit: string;
  /** Currently loaded SAM model ID (null = no model loaded) */
  samModelId: string | null;
  /** Whether the editor is in ROI selection mode */
  isROIMode: boolean;
  /** Called when the user finishes drawing a ROI rectangle */
  onROIComplete: () => void;
}

export const ImageEditor: React.FC<ImageEditorProps> = ({ 
  isCalibrationMode, 
  onCalibrationComplete,
  calibrationUnit,
  samModelId,
  isROIMode,
  onROIComplete,
}) => {
  const { getCurrentImage, addMeasurement, updateCalibration, setImages, updateSamROI } = useMedidor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Cached decoded Image to avoid re-decoding base64 on every render frame
  const cachedImageRef = useRef<{ dataUrl: string; img: HTMLImageElement } | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<DrawingPoint[]>([]);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number } | null>(null);
  const [hoveredEndpoint, setHoveredEndpoint] = useState<{ measurementId: string; isStart: boolean } | null>(null);
  const [extendingMeasurement, setExtendingMeasurement] = useState<{ measurementId: string; isStart: boolean } | null>(null);
  // ROI drawing state
  const [roiStart, setRoiStart] = useState<{ x: number; y: number } | null>(null);
  const [roiCurrent, setRoiCurrent] = useState<{ x: number; y: number } | null>(null);
  // Embeddings computation state
  const [embeddingsProgress, setEmbeddingsProgress] = useState<number | null>(null);
  const [isComputingEmbeddings, setIsComputingEmbeddings] = useState(false);
  // View transform state (zoom & pan)
  const [viewScale, setViewScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  // Canvas dimensions
  const [canvasWidth, setCanvasWidth] = useState(800);
  const [canvasHeight, setCanvasHeight] = useState(600);
  // Per-image history for undo/redo  (imageId → { entries, index })
  const [historyMap, setHistoryMap] = useState<Map<string, { entries: DrawingLine[][]; index: number }>>(new Map());
  const currentImage = getCurrentImage();

  // Current image history helpers
  const imgHistory = currentImage ? historyMap.get(currentImage.id) : undefined;
  const history = useMemo(() => imgHistory?.entries ?? [], [imgHistory]);
  const historyIndex = imgHistory?.index ?? -1;

  // Derived: are embeddings ready for this image + loaded model?
  const embeddingsReady = !!(currentImage?.embeddingsModelId && currentImage.embeddingsModelId === samModelId);
  const canComputeEmbeddings = !!(samModelId && currentImage?.samROI && !embeddingsReady && !isComputingEmbeddings);

  // Compute embeddings on the current image's ROI crop
  const handleComputeEmbeddings = useCallback(async () => {
    if (!currentImage || !samModelId || !currentImage.samROI || isComputingEmbeddings) return;
    setIsComputingEmbeddings(true);
    setEmbeddingsProgress(0);
    try {
      const croppedDataUrl = await cropImageToROI(currentImage.dataUrl, currentImage.samROI);
      await getOrComputeEmbeddings(currentImage.id, croppedDataUrl, (progress: number) => {
        setEmbeddingsProgress(progress);
      });
      const modelId = getLoadedModelId();
      setImages(prev => prev.map(img =>
        img.id === currentImage.id ? { ...img, embeddingsModelId: modelId ?? undefined } : img
      ));
    } catch (err) {
      console.error('Error computing embeddings:', err);
      alert('Error al calcular embeddings: ' + (err as Error).message);
    } finally {
      setIsComputingEmbeddings(false);
      setEmbeddingsProgress(null);
    }
  }, [currentImage, samModelId, isComputingEmbeddings, setImages]);

  // ── History (pure state, render-time adjustment pattern) ───────
  // Save current measurements state to history for the active image
  const saveToHistory = useCallback((imageId: string, measurements: DrawingLine[], h: DrawingLine[][], hIdx: number) => {
    const newEntries = h.slice(0, hIdx + 1);
    newEntries.push(JSON.parse(JSON.stringify(measurements)));
    if (newEntries.length > 50) newEntries.shift();
    const newIdx = newEntries.length - 1;
    setHistoryMap(prev => {
      const next = new Map(prev);
      next.set(imageId, { entries: newEntries, index: newIdx });
      return next;
    });
  }, []);

  // Initialize history when image changes (render-time state adjustment — React recommended pattern)
  const [prevImageId, setPrevImageId] = useState<string | undefined>(undefined);
  const [prevMeasurementsStr, setPrevMeasurementsStr] = useState('');
  if (currentImage?.id !== prevImageId) {
    setPrevImageId(currentImage?.id);
    if (currentImage) {
      // Only init if no history exists yet for this image
      if (!historyMap.has(currentImage.id)) {
        const init: DrawingLine[][] = [JSON.parse(JSON.stringify(currentImage.measurements))];
        setHistoryMap(prev => {
          const next = new Map(prev);
          next.set(currentImage.id, { entries: init, index: 0 });
          return next;
        });
      }
      setPrevMeasurementsStr(JSON.stringify(currentImage.measurements));
    }
  }

  // Track external measurement changes (e.g. panel delete) — render-time adjustment
  const curMeasurementsJson = currentImage ? JSON.stringify(currentImage.measurements) : '';
  if (currentImage && history.length > 0 && curMeasurementsJson !== prevMeasurementsStr) {
    setPrevMeasurementsStr(curMeasurementsJson);
    const histMeasurements = JSON.stringify(history[historyIndex]);
    if (curMeasurementsJson !== histMeasurements) {
      const newEntries = history.slice(0, historyIndex + 1);
      newEntries.push(JSON.parse(curMeasurementsJson));
      if (newEntries.length > 50) newEntries.shift();
      const newIdx = newEntries.length - 1;
      setHistoryMap(prev => {
        const next = new Map(prev);
        next.set(currentImage.id, { entries: newEntries, index: newIdx });
        return next;
      });
    }
  }

  // Undo function
  const handleUndo = useCallback(() => {
    if (!currentImage || historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    const measurements = history[newIndex];
    setImages((prev) =>
      prev.map((img) =>
        img.id === currentImage.id
          ? { ...img, measurements: JSON.parse(JSON.stringify(measurements)) }
          : img
      )
    );
    setHistoryMap(prev => {
      const next = new Map(prev);
      const entry = next.get(currentImage.id);
      if (entry) next.set(currentImage.id, { ...entry, index: newIndex });
      return next;
    });
    setPrevMeasurementsStr(JSON.stringify(measurements));
  }, [currentImage, setImages, historyIndex, history, setPrevMeasurementsStr]);

  // Redo function
  const handleRedo = useCallback(() => {
    if (!currentImage || historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    const measurements = history[newIndex];
    setImages((prev) =>
      prev.map((img) =>
        img.id === currentImage.id
          ? { ...img, measurements: JSON.parse(JSON.stringify(measurements)) }
          : img
      )
    );
    setHistoryMap(prev => {
      const next = new Map(prev);
      const entry = next.get(currentImage.id);
      if (entry) next.set(currentImage.id, { ...entry, index: newIndex });
      return next;
    });
    setPrevMeasurementsStr(JSON.stringify(measurements));
  }, [currentImage, setImages, historyIndex, history, setPrevMeasurementsStr]);

  // Update canvas size based on container
  useEffect(() => {
    const updateCanvasSize = () => {
      if (!containerRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      
      if (width > 0 && height > 0) {
        setCanvasWidth(width);
        setCanvasHeight(height);
      }
    };

    updateCanvasSize();
    
    const resizeObserver = new ResizeObserver(updateCanvasSize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => resizeObserver.disconnect();
  }, []);

  // Helper to draw endpoint circles
  const drawEndpoint = useCallback((ctx: CanvasRenderingContext2D, point: DrawingPoint, isHovered: boolean) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 8 / viewScale, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? 'rgba(255, 255, 0, 0.6)' : 'rgba(255, 0, 0, 0.3)';
    ctx.fill();
    ctx.strokeStyle = isHovered ? 'rgba(255, 200, 0, 0.9)' : 'rgba(255, 0, 0, 0.6)';
    ctx.lineWidth = 2 / viewScale;
    ctx.stroke();
    ctx.restore();
  }, [viewScale]);

  // Helper to check if mouse is near a point
  const isNearPoint = (px: number, py: number, point: DrawingPoint, threshold: number = 12) => {
    const dx = px - point.x;
    const dy = py - point.y;
    return Math.sqrt(dx * dx + dy * dy) <= threshold / viewScale;
  };

  // Function to reset view centered on image
  const imageWidth = currentImage?.width ?? 0;
  const imageHeight = currentImage?.height ?? 0;
  const resetViewToImage = useCallback(() => {
    if (!imageWidth || !imageHeight) return;
    
    // Calculate scale to fit image in canvas
    const scaleX = canvasWidth / imageWidth;
    const scaleY = canvasHeight / imageHeight;
    const fitScale = Math.min(scaleX, scaleY, 1); // Don't scale up beyond 1:1
    
    // Center the image
    const scaledWidth = imageWidth * fitScale;
    const scaledHeight = imageHeight * fitScale;
    const centerX = (canvasWidth - scaledWidth) / 2;
    const centerY = (canvasHeight - scaledHeight) / 2;
    
    setViewScale(fitScale);
    setOffsetX(centerX);
    setOffsetY(centerY);
  }, [imageWidth, imageHeight, canvasWidth, canvasHeight]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Reset zoom with 'R' key
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        resetViewToImage();
      }
      // Undo with Ctrl+Z
      if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      // Redo with Ctrl+Shift+Z or Ctrl+Y
      if ((e.ctrlKey && e.shiftKey && e.key === 'Z') || (e.ctrlKey && e.key === 'y')) {
        e.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [resetViewToImage, handleUndo, handleRedo]);

  // Pre-load / cache the image whenever the dataUrl changes
  const imageDataUrl = currentImage?.dataUrl;
  useEffect(() => {
    if (!imageDataUrl) { cachedImageRef.current = null; return; }
    if (cachedImageRef.current?.dataUrl === imageDataUrl) return; // already cached
    const img = new Image();
    img.onload = () => { cachedImageRef.current = { dataUrl: imageDataUrl, img }; };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  // Redraw canvas
  useEffect(() => {
    if (!canvasRef.current || !currentImage) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to container size (not image size)
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Use cached image if available; otherwise decode (first frame)
    const doDraw = (imgToDraw: HTMLImageElement) => {
      // Clear and apply view transform
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(viewScale, 0, 0, viewScale, offsetX, offsetY);
      ctx.drawImage(imgToDraw, 0, 0);

      // Draw measurements (lines only) + labels + endpoints
      currentImage.measurements.forEach((measurement: DrawingLine, idx: number) => {
        if (measurement.type === 'measurement') {
          drawLine(ctx, measurement.points, '#FF0000', 2);

          // Draw endpoint circles
          if (measurement.points.length > 0) {
            const startPoint = measurement.points[0];
            const endPoint = measurement.points[measurement.points.length - 1];
            
            const isStartHovered = hoveredEndpoint?.measurementId === measurement.id && hoveredEndpoint?.isStart;
            const isEndHovered = hoveredEndpoint?.measurementId === measurement.id && !hoveredEndpoint?.isStart;
            
            drawEndpoint(ctx, startPoint, isStartHovered);
            drawEndpoint(ctx, endPoint, isEndHovered);
          }

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

      // Draw calibration line if exists (line only)
      if (currentImage.calibration?.calibrationLine) {
        drawLine(ctx, currentImage.calibration.calibrationLine.points, '#00FF00', 3);
      }

      // Draw current drawing
      if (currentPoints.length > 0) {
        const color = isCalibrationMode ? '#0000FF' : '#FF0000';
        drawLine(ctx, currentPoints, color, 2);
      }

      // Draw stored ROI rectangle
      if (currentImage.samROI) {
        const roi = currentImage.samROI;
        ctx.save();
        ctx.setLineDash([8 / viewScale, 4 / viewScale]);
        ctx.strokeStyle = '#2196F3';
        ctx.lineWidth = 2 / viewScale;
        ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Draw in-progress ROI rectangle while dragging
      if (roiStart && roiCurrent) {
        const rx = Math.min(roiStart.x, roiCurrent.x);
        const ry = Math.min(roiStart.y, roiCurrent.y);
        const rw = Math.abs(roiCurrent.x - roiStart.x);
        const rh = Math.abs(roiCurrent.y - roiStart.y);
        ctx.save();
        ctx.setLineDash([8 / viewScale, 4 / viewScale]);
        ctx.strokeStyle = '#2196F3';
        ctx.lineWidth = 2 / viewScale;
        ctx.fillStyle = 'rgba(33, 150, 243, 0.1)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }; // end doDraw

    if (cachedImageRef.current?.dataUrl === currentImage.dataUrl) {
      doDraw(cachedImageRef.current.img);
    } else {
      // Fallback: decode once and cache
      const img = new Image();
      img.onload = () => {
        cachedImageRef.current = { dataUrl: currentImage.dataUrl, img };
        doDraw(img);
      };
      img.src = currentImage.dataUrl;
    }
  }, [currentImage, currentPoints, isCalibrationMode, viewScale, offsetX, offsetY, canvasWidth, canvasHeight, hoveredEndpoint, drawEndpoint, roiStart, roiCurrent]);

  // Reset view when image changes (defer to next frame)
  const currentImageId = currentImage?.id;
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      resetViewToImage();
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageId, canvasWidth, canvasHeight]);

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

    // Right click: start panning
    if (e.button === 2) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      return;
    }

    // ROI mode: start rectangle selection
    if (isROIMode && e.button === 0) {
      setRoiStart(newPoint);
      setRoiCurrent(newPoint);
      return;
    }

    // Check if clicking on an endpoint (only in measurement mode)
    if (!isCalibrationMode) {
      for (const measurement of currentImage.measurements) {
        if (measurement.type === 'measurement' && measurement.points.length > 0) {
          const startPoint = measurement.points[0];
          const endPoint = measurement.points[measurement.points.length - 1];
          
          if (isNearPoint(p.x, p.y, startPoint)) {
            setIsDrawing(true);
            setExtendingMeasurement({ measurementId: measurement.id, isStart: true });
            setCurrentPoints([...measurement.points]);
            return;
          }
          
          if (isNearPoint(p.x, p.y, endPoint)) {
            setIsDrawing(true);
            setExtendingMeasurement({ measurementId: measurement.id, isStart: false });
            setCurrentPoints([...measurement.points]);
            return;
          }
        }
      }
    }

    // Normal behavior: start new drawing
    setIsDrawing(true);
    setExtendingMeasurement(null);
    setCurrentPoints([newPoint]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;

    // Handle panning with right mouse button
    if (isPanning && panStart) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      setOffsetX(prev => prev + dx);
      setOffsetY(prev => prev + dy);
      setPanStart({ x: e.clientX, y: e.clientY });
      return;
    }

    const { x, y } = getCanvasCoords(e);
    const p = toImageCoords(x, y);
    const newPoint = { x: p.x, y: p.y };

    // ROI mode: update rectangle end corner
    if (isROIMode && roiStart) {
      setRoiCurrent(newPoint);
      return;
    }

    // Update hover state (only in measurement mode when not drawing)
    if (!isDrawing && !isCalibrationMode && currentImage) {
      let foundHover = false;
      for (const measurement of currentImage.measurements) {
        if (measurement.type === 'measurement' && measurement.points.length > 0) {
          const startPoint = measurement.points[0];
          const endPoint = measurement.points[measurement.points.length - 1];
          
          if (isNearPoint(p.x, p.y, startPoint)) {
            setHoveredEndpoint({ measurementId: measurement.id, isStart: true });
            foundHover = true;
            break;
          }
          
          if (isNearPoint(p.x, p.y, endPoint)) {
            setHoveredEndpoint({ measurementId: measurement.id, isStart: false });
            foundHover = true;
            break;
          }
        }
      }
      if (!foundHover && hoveredEndpoint) {
        setHoveredEndpoint(null);
      }
    }

    // Handle drawing
    if (isDrawing) {
      if (isCalibrationMode) {
        setCurrentPoints([currentPoints[0], newPoint]);
      } else if (extendingMeasurement) {
        if (extendingMeasurement.isStart) {
          setCurrentPoints((prev) => [newPoint, ...prev]);
        } else {
          setCurrentPoints((prev) => [...prev, newPoint]);
        }
      } else {
        setCurrentPoints((prev) => [...prev, newPoint]);
      }
    }
  };

  const handleMouseUp = async () => {
    // End panning
    if (isPanning) {
      setIsPanning(false);
      setPanStart(null);
      return;
    }

    // ROI mode: finish rectangle selection
    if (isROIMode && roiStart && roiCurrent && currentImage) {
      const rx = Math.min(roiStart.x, roiCurrent.x);
      const ry = Math.min(roiStart.y, roiCurrent.y);
      const rw = Math.abs(roiCurrent.x - roiStart.x);
      const rh = Math.abs(roiCurrent.y - roiStart.y);
      // Only save if the rectangle has a meaningful size
      if (rw > 5 && rh > 5) {
        updateSamROI(currentImage.id, { x: rx, y: ry, width: rw, height: rh });
      }
      setRoiStart(null);
      setRoiCurrent(null);
      onROIComplete();
      return;
    }

    if (!isDrawing || !currentImage) return;
    setIsDrawing(false);

    if (currentPoints.length < 2) {
      setCurrentPoints([]);
      setExtendingMeasurement(null);
      return;
    }

    if (isCalibrationMode) {
      const pixelLength = calculateTotalDistance(currentPoints);
      const calibrationLine: DrawingLine = {
        id: generateId(),
        points: currentPoints,
        imageId: currentImage.id,
        type: 'calibration',
        pixelLength,
        timestamp: Date.now(),
      };

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

          onCalibrationComplete();
        } else {
          alert('Longitud inválida. Por favor, intenta de nuevo.');
        }
      }
    } else if (extendingMeasurement) {
      const pixelLength = calculateTotalDistance(currentPoints);
      const updatedMeasurements = currentImage.measurements.map((m) => 
        m.id === extendingMeasurement.measurementId
          ? { ...m, points: currentPoints, pixelLength, timestamp: Date.now() }
          : m
      );
      
      setImages((prev) =>
        prev.map((img) =>
          img.id === currentImage.id
            ? { ...img, measurements: updatedMeasurements }
            : img
        )
      );
      saveToHistory(currentImage.id, updatedMeasurements, history, historyIndex);
      setPrevMeasurementsStr(JSON.stringify(updatedMeasurements));
    } else {
      const pixelLength = calculateTotalDistance(currentPoints);
      const measurement: DrawingLine = {
        id: generateId(),
        points: currentPoints,
        imageId: currentImage.id,
        type: 'measurement',
        pixelLength,
        timestamp: Date.now(),
      };

      addMeasurement(currentImage.id, measurement);
      const newMeasurements = [...currentImage.measurements, measurement];
      saveToHistory(currentImage.id, newMeasurements, history, historyIndex);
      setPrevMeasurementsStr(JSON.stringify(newMeasurements));
    }

    setCurrentPoints([]);
    setExtendingMeasurement(null);
  };

  const handleWheel = useCallback((e: WheelEvent) => {
    if (!canvasRef.current) return;
    e.preventDefault();

    const zoomIntensity = 0.0015;
    const scaleFactor = Math.exp(-e.deltaY * zoomIntensity);
    const newScale = Math.min(10, Math.max(0.1, viewScale * scaleFactor));

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const wx = (x - offsetX) / viewScale;
    const wy = (y - offsetY) / viewScale;

    const newOffsetX = x - wx * newScale;
    const newOffsetY = y - wy * newScale;

    setViewScale(newScale);
    setOffsetX(newOffsetX);
    setOffsetY(newOffsetY);
  }, [viewScale, offsetX, offsetY]);

  // Attach non-passive wheel listener so preventDefault works
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleResetView = () => {
    resetViewToImage();
  };

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
      {isROIMode && (
        <div className={styles.calibrationBanner} style={{ backgroundColor: 'rgba(33, 150, 243, 0.15)', borderColor: '#2196F3' }}>
          🔲 Modo ROI: Arrastra para definir la región de interés
        </div>
      )}
      <div className={styles.toolbar}>
        <button className={styles.toolbarButton} onClick={handleResetView} title="Restablecer vista (zoom/pan) - Atajo: R">
          Restablecer zoom
        </button>
        <span className={styles.zoomInfo}>{Math.round(viewScale * 100)}%</span>
        <button 
          className={styles.toolbarButton} 
          onClick={handleUndo}
          disabled={historyIndex <= 0}
          title="Deshacer - Atajo: Ctrl+Z"
        >
          ↶ Deshacer
        </button>
        <button 
          className={styles.toolbarButton} 
          onClick={handleRedo}
          disabled={historyIndex >= history.length - 1}
          title="Rehacer - Atajo: Ctrl+Shift+Z o Ctrl+Y"
        >
          ↷ Rehacer
        </button>
        {embeddingsReady && (
          <span className={styles.zoomInfo} style={{ color: '#4caf50' }}>🧠 Embeddings listos</span>
        )}
        {/* Spacer to push embeddings button to the right */}
        <div style={{ flex: 1 }} />
        {/* Embeddings button — right side of toolbar */}
        {samModelId && currentImage.samROI && !embeddingsReady && (
          <button
            className={`${styles.embeddingsBtn}`}
            onClick={handleComputeEmbeddings}
            disabled={!canComputeEmbeddings}
            title={
              isComputingEmbeddings
                ? `Calculando... ${Math.round(embeddingsProgress ?? 0)}%`
                : 'Calcular embeddings IA sobre el ROI'
            }
          >
            {isComputingEmbeddings ? `⏳ ${Math.round(embeddingsProgress ?? 0)}%` : '🧠 Calcular'}
          </button>
        )}
      </div>
      <div className={styles.canvasContainer} ref={containerRef}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onContextMenu={(e) => e.preventDefault()}
          style={{ 
            cursor: isROIMode
              ? 'crosshair'
              : isCalibrationMode
              ? 'crosshair' 
              : (isPanning ? 'grabbing' : (isDrawing ? 'crosshair' : (hoveredEndpoint ? 'grab' : 'default')))
          }}
        />
      </div>
    </div>
  );
};
