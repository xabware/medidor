import React, { useRef, useEffect, useState } from 'react';
import { useMedidor } from '../context/MedidorContext';
import type { DrawingPoint, DrawingLine, CropRegion } from '../types';
import { calculateTotalDistance, drawLine, generateId } from '../utils/drawing';
import { detectRoots, drawHistogram, type HistogramData } from '../utils/rootDetection';
import styles from './ImageEditor.module.css';

interface ImageEditorProps {
  isCalibrationMode: boolean;
  onCalibrationComplete: () => void;
  isCropMode: boolean;
  onCropComplete: () => void;
  calibrationUnit: string;
}

export const ImageEditor: React.FC<ImageEditorProps> = ({ 
  isCalibrationMode, 
  onCalibrationComplete,
  isCropMode,
  onCropComplete,
  calibrationUnit 
}) => {
  const { getCurrentImage, addMeasurement, updateCalibration, updateCrop, images, setImages } = useMedidor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const histogramCanvasRef = useRef<HTMLCanvasElement>(null);
  const thresholdCanvasRef = useRef<HTMLCanvasElement>(null);
  const edgesCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<DrawingPoint[]>([]);
  const [cropStart, setCropStart] = useState<DrawingPoint | null>(null);
  const [cropEnd, setCropEnd] = useState<DrawingPoint | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number } | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [hoveredEndpoint, setHoveredEndpoint] = useState<{ measurementId: string; isStart: boolean } | null>(null);
  const [extendingMeasurement, setExtendingMeasurement] = useState<{ measurementId: string; isStart: boolean } | null>(null);
  const [histogram, setHistogram] = useState<HistogramData | null>(null);
  const [thresholds, setThresholds] = useState<{ min: number; max: number } | null>(null);
  const [thresholdedImage, setThresholdedImage] = useState<ImageData | null>(null);
  const [edgesImage, setEdgesImage] = useState<ImageData | null>(null);
  const [detectedLines, setDetectedLines] = useState<Array<{ points: Array<{ x: number; y: number }> }>>([]);
  // View transform state (zoom & pan)
  const [viewScale, setViewScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  // Canvas dimensions
  const [canvasWidth, setCanvasWidth] = useState(800);
  const [canvasHeight, setCanvasHeight] = useState(600);
  // History for undo/redo
  const [history, setHistory] = useState<DrawingLine[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const currentImage = getCurrentImage();

  // Save current measurements state to history
  const saveToHistory = (measurements: DrawingLine[]) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(JSON.parse(JSON.stringify(measurements)));
    // Limit history to 50 steps
    if (newHistory.length > 50) {
      newHistory.shift();
      setHistoryIndex(49);
    } else {
      setHistoryIndex(newHistory.length - 1);
    }
    setHistory(newHistory);
  };

  // Initialize history when image changes
  useEffect(() => {
    if (currentImage) {
      setHistory([JSON.parse(JSON.stringify(currentImage.measurements))]);
      setHistoryIndex(0);
    }
  }, [currentImage?.id]);

  // Track measurements changes to update history (but only from external sources)
  useEffect(() => {
    if (!currentImage || history.length === 0) return;
    
    const currentMeasurements = JSON.stringify(currentImage.measurements);
    const historyMeasurements = JSON.stringify(history[historyIndex]);
    
    // If measurements changed from external source (like delete from panel), update history
    if (currentMeasurements !== historyMeasurements) {
      saveToHistory(currentImage.measurements);
    }
  }, [currentImage?.measurements]);

  // Undo function
  const handleUndo = () => {
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
    setHistoryIndex(newIndex);
  };

  // Redo function
  const handleRedo = () => {
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
    setHistoryIndex(newIndex);
  };

  // Update canvas size based on container
  useEffect(() => {
    const updateCanvasSize = () => {
      if (!canvasRef.current) return;
      const container = canvasRef.current.parentElement;
      if (!container) return;
      
      const rect = container.getBoundingClientRect();
      const width = Math.max(400, rect.width - 20);
      const height = Math.max(300, rect.height - 20);
      
      setCanvasWidth(width);
      setCanvasHeight(height);
    };

    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);
    return () => window.removeEventListener('resize', updateCanvasSize);
  }, []);

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
  }, [historyIndex, history, currentImage]);

  // Helper to draw endpoint circles
  const drawEndpoint = (ctx: CanvasRenderingContext2D, point: DrawingPoint, isHovered: boolean) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 8 / viewScale, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? 'rgba(255, 255, 0, 0.6)' : 'rgba(255, 0, 0, 0.3)';
    ctx.fill();
    ctx.strokeStyle = isHovered ? 'rgba(255, 200, 0, 0.9)' : 'rgba(255, 0, 0, 0.6)';
    ctx.lineWidth = 2 / viewScale;
    ctx.stroke();
    ctx.restore();
  };

  // Helper to check if mouse is near a point
  const isNearPoint = (px: number, py: number, point: DrawingPoint, threshold: number = 12) => {
    const dx = px - point.x;
    const dy = py - point.y;
    return Math.sqrt(dx * dx + dy * dy) <= threshold / viewScale;
  };

  // Function to reset view centered on image
  const resetViewToImage = () => {
    if (!currentImage) return;
    
    // Use original dimensions in crop mode, otherwise use cropped if available
    const imageWidth = isCropMode ? currentImage.width : (currentImage.crop ? currentImage.crop.width : currentImage.width);
    const imageHeight = isCropMode ? currentImage.height : (currentImage.crop ? currentImage.crop.height : currentImage.height);
    
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
  };

  // Redraw canvas
  useEffect(() => {
    if (!canvasRef.current || !currentImage) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to container size (not image size)
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Draw image
    const img = new Image();
    img.onload = () => {
      // Clear and apply view transform
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(viewScale, 0, 0, viewScale, offsetX, offsetY);

      // Use original image in crop mode, otherwise use cropped if available
      const imageToUse = isCropMode ? currentImage.dataUrl : (currentImage.crop ? currentImage.crop.croppedDataUrl : currentImage.dataUrl);
      const imgToDraw = new Image();
      imgToDraw.onload = () => {
        ctx.drawImage(imgToDraw, 0, 0);
        
        // Draw measurements, etc.
        drawOverlays();
      };
      imgToDraw.src = imageToUse;
    };

    const drawOverlays = () => {

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
      if (currentPoints.length > 0 && !isCropMode) {
        const color = isCalibrationMode ? '#0000FF' : '#FF0000';
        drawLine(ctx, currentPoints, color, 2);
      }
      
      // Draw crop rectangle if in crop mode
      if (isCropMode && cropStart && cropEnd) {
        ctx.save();
        const x = Math.min(cropStart.x, cropEnd.x);
        const y = Math.min(cropStart.y, cropEnd.y);
        const width = Math.abs(cropEnd.x - cropStart.x);
        const height = Math.abs(cropEnd.y - cropStart.y);
        
        // Semi-transparent overlay outside crop area
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, currentImage.width, y); // top
        ctx.fillRect(0, y, x, height); // left
        ctx.fillRect(x + width, y, currentImage.width - (x + width), height); // right
        ctx.fillRect(0, y + height, currentImage.width, currentImage.height - (y + height)); // bottom
        
        // Crop rectangle border
        ctx.strokeStyle = '#00FF00';
        ctx.lineWidth = 2 / viewScale;
        ctx.strokeRect(x, y, width, height);
        ctx.restore();
      }
    };
    img.src = currentImage.dataUrl;
  }, [currentImage, currentPoints, isCalibrationMode, isCropMode, cropStart, cropEnd, viewScale, offsetX, offsetY, detectedLines, canvasWidth, canvasHeight, hoveredEndpoint]);

  // Reset crop state when entering crop mode
  useEffect(() => {
    if (isCropMode) {
      setCropStart(null);
      setCropEnd(null);
    }
  }, [isCropMode]);

  // Reset view when image changes or crop mode changes (defer to next frame)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      resetViewToImage();
    });
    return () => cancelAnimationFrame(raf);
  }, [currentImage?.id, canvasWidth, canvasHeight, isCropMode]);

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

    // Left click continues with normal behavior
    // Crop mode: start drawing rectangle
    if (isCropMode) {
      setCropStart(newPoint);
      setCropEnd(newPoint);
      setIsDrawing(true);
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

    // Crop mode: update rectangle
    if (isDrawing && isCropMode && cropStart) {
      setCropEnd(newPoint);
      return;
    }

    // Update hover state (only in measurement mode when not drawing)
    if (!isDrawing && !isCalibrationMode && !isCropMode && currentImage) {
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
        // En modo calibración, mostrar una línea recta desde el inicio hasta la posición actual
        setCurrentPoints([currentPoints[0], newPoint]);
      } else if (extendingMeasurement) {
        // Extending existing measurement
        if (extendingMeasurement.isStart) {
          // Adding to the start (prepend points)
          setCurrentPoints((prev) => [newPoint, ...prev]);
        } else {
          // Adding to the end (append points)
          setCurrentPoints((prev) => [...prev, newPoint]);
        }
      } else {
        // Normal new measurement
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

    if (!isDrawing || !currentImage) return;
    setIsDrawing(false);

    // Crop mode: process the crop
    if (isCropMode && cropStart && cropEnd) {
      const x = Math.min(cropStart.x, cropEnd.x);
      const y = Math.min(cropStart.y, cropEnd.y);
      const width = Math.abs(cropEnd.x - cropStart.x);
      const height = Math.abs(cropEnd.y - cropStart.y);

      if (width > 10 && height > 10) {
        // Create a temporary canvas to crop the image
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');

        if (tempCtx) {
          const img = new Image();
          await new Promise<void>((resolve) => {
            img.onload = () => {
              // Draw the cropped portion
              tempCtx.drawImage(img, x, y, width, height, 0, 0, width, height);
              resolve();
            };
            img.src = currentImage.dataUrl;
          });

          const croppedDataUrl = tempCanvas.toDataURL('image/png');
          const cropRegion: CropRegion = {
            x,
            y,
            width,
            height,
            croppedDataUrl,
            timestamp: Date.now(),
          };

          updateCrop(currentImage.id, cropRegion);
          onCropComplete();
        }
      }

      setCropStart(null);
      setCropEnd(null);
      return;
    }

    if (currentPoints.length < 2) {
      setCurrentPoints([]);
      setExtendingMeasurement(null);
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
    } else if (extendingMeasurement) {
      // Update existing measurement
      const pixelLength = calculateTotalDistance(currentPoints);
      const updatedMeasurements = currentImage.measurements.map((m) => 
        m.id === extendingMeasurement.measurementId
          ? { ...m, points: currentPoints, pixelLength, timestamp: Date.now() }
          : m
      );
      
      // Replace all measurements for this image
      setImages((prev) =>
        prev.map((img) =>
          img.id === currentImage.id
            ? { ...img, measurements: updatedMeasurements }
            : img
        )
      );
      saveToHistory(updatedMeasurements);
    } else {
      // Guardar nueva medición
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
      saveToHistory([...currentImage.measurements, measurement]);
    }

    setCurrentPoints([]);
    setExtendingMeasurement(null);
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
    resetViewToImage();
  };

  const handleAutoDetect = async () => {
    if (!canvasRef.current || !currentImage || isDetecting) return;
    
    setIsDetecting(true);
    try {
      // Use cropped image if available, otherwise use original
      const imageDataUrl = currentImage.crop ? currentImage.crop.croppedDataUrl : currentImage.dataUrl;
      const imageWidth = currentImage.crop ? currentImage.crop.width : currentImage.width;
      const imageHeight = currentImage.crop ? currentImage.crop.height : currentImage.height;
      
      // Crear un canvas temporal con la imagen sin transformaciones
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = imageWidth;
      tempCanvas.height = imageHeight;
      const tempCtx = tempCanvas.getContext('2d');
      
      if (!tempCtx) throw new Error('No se pudo crear canvas temporal');
      
      // Cargar y dibujar la imagen (original o recortada)
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          tempCtx.drawImage(img, 0, 0);
          resolve();
        };
        img.onerror = reject;
        img.src = imageDataUrl;
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

    const newMeasurements = [...currentImage.measurements];
    selected.forEach(line => {
      if (line.points.length > 1) {
        const measurement = {
          id: generateId(),
          imageId: currentImage.id,
          type: 'measurement' as const,
          points: line.points,
          pixelLength: calculateTotalDistance(line.points),
          timestamp: Date.now()
        };
        addMeasurement(currentImage.id, measurement);
        newMeasurements.push(measurement);
      }
    });
    
    saveToHistory(newMeasurements);

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
      {isCropMode && (
        <div className={styles.calibrationBanner} style={{ backgroundColor: '#9c27b0' }}>
          ✂️ Modo recorte: Arrastra en el canvas para dibujar un rectángulo de recorte
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
        <div style={{ flex: 1 }}></div>
        <button 
          className={styles.toolbarButton} 
          onClick={handleAutoDetect}
          disabled={isDetecting || isCalibrationMode || isCropMode}
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
          onContextMenu={(e) => e.preventDefault()}
          style={{ 
            cursor: (isCalibrationMode || isCropMode)
              ? 'crosshair' 
              : (isPanning ? 'grabbing' : (isDrawing ? 'crosshair' : (hoveredEndpoint ? 'grab' : 'default')))
          }}
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
