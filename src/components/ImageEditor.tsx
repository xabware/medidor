import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useMedidor } from '../context/useMedidor';
import type { DrawingPoint, DrawingLine, ROIRegion } from '../types';
import { calculateTotalDistance, drawLine, generateId } from '../utils/drawing';
import { getOrComputeEmbeddings, getLoadedModelId, computeMaskCandidates, processChosenMask, snapToSkeleton, clearEmbeddingsCache } from '../utils/samSegmentation';
import type { MaskCandidate, MaskCandidatesResult, ProcessedMaskResult } from '../utils/samSegmentation';
import { setDebugROIImageUrl, setDebugEnabled } from '../utils/samDebugVisualizer';
import { normalizeImage } from '../utils/imageNormalization';
import styles from './ImageEditor.module.css';

/**
 * Takes 4 points clicked in any order and returns them sorted as
 * [TopLeft, TopRight, BottomRight, BottomLeft].
 */
function sortCornersToQuad(pts: DrawingPoint[]): [DrawingPoint, DrawingPoint, DrawingPoint, DrawingPoint] {
  // Centroid Y for top/bottom split
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  // Classify above / below centroid
  const top: DrawingPoint[] = [];
  const bot: DrawingPoint[] = [];
  for (const p of pts) {
    if (p.y < cy) top.push(p);
    else bot.push(p);
  }
  // Edge case: if not 2-2 split, sort by y and take first 2 as top
  if (top.length !== 2 || bot.length !== 2) {
    const sorted = [...pts].sort((a, b) => a.y - b.y);
    top.length = 0;
    bot.length = 0;
    top.push(sorted[0], sorted[1]);
    bot.push(sorted[2], sorted[3]);
  }
  // Within each pair, leftmost first
  top.sort((a, b) => a.x - b.x);
  bot.sort((a, b) => a.x - b.x);
  // TL, TR, BR, BL
  return [top[0], top[1], bot[1], bot[0]];
}

/** Crop a data-URL image to the given ROI and return a new data-URL. */
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

function getPixelAlignedROI(roi: ROIRegion): ROIRegion {
  return {
    x: Math.round(roi.x),
    y: Math.round(roi.y),
    width: Math.round(roi.width),
    height: Math.round(roi.height),
  };
}

function cloneMask(mask: boolean[][]): boolean[][] {
  return mask.map(row => row.slice());
}

function erodeMask(mask: boolean[][], iterations = 1): boolean[][] {
  if (iterations <= 0 || mask.length === 0 || mask[0].length === 0) return cloneMask(mask);
  const H = mask.length;
  const W = mask[0].length;
  let current = cloneMask(mask);

  for (let it = 0; it < iterations; it++) {
    const next: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!current[y][x]) continue;
        let keep = true;
        for (let dy = -1; dy <= 1 && keep; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || ny >= H || nx < 0 || nx >= W || !current[ny][nx]) {
              keep = false;
              break;
            }
          }
        }
        next[y][x] = keep;
      }
    }
    current = next;
  }

  return current;
}

function eraseFromMeasurements(
  measurements: DrawingLine[],
  center: DrawingPoint,
  radius: number,
): { next: DrawingLine[]; changed: boolean } {
  const radiusSq = radius * radius;
  const next: DrawingLine[] = [];
  let changed = false;

  for (const measurement of measurements) {
    if (measurement.type !== 'measurement' || measurement.points.length < 2) {
      next.push(measurement);
      continue;
    }

    const segments: DrawingPoint[][] = [];
    let currentSegment: DrawingPoint[] = [];
    let erasedAny = false;

    for (const pt of measurement.points) {
      const dx = pt.x - center.x;
      const dy = pt.y - center.y;
      const isErased = (dx * dx + dy * dy) <= radiusSq;

      if (isErased) {
        erasedAny = true;
        if (currentSegment.length >= 2) segments.push(currentSegment);
        currentSegment = [];
      } else {
        currentSegment.push(pt);
      }
    }

    if (currentSegment.length >= 2) segments.push(currentSegment);

    if (!erasedAny) {
      next.push(measurement);
      continue;
    }

    changed = true;
    for (let i = 0; i < segments.length; i++) {
      const points = segments[i];
      next.push({
        ...measurement,
        id: i === 0 ? measurement.id : generateId(),
        points,
        pixelLength: calculateTotalDistance(points),
        timestamp: Date.now(),
      });
    }
  }

  return { next, changed };
}

const NORMAL_ERASE_BRUSH_RADIUS = 4;
const MEASUREMENT_MERGE_THRESHOLD = 14;

function findEndpointMergeTarget(
  measurements: DrawingLine[],
  endPoint: DrawingPoint,
  threshold: number,
  excludeMeasurementId?: string,
): { line: DrawingLine; connectToStart: boolean } | null {
  let best: { line: DrawingLine; connectToStart: boolean } | null = null;
  let bestDistSq = threshold * threshold;

  for (const m of measurements) {
    if (m.type !== 'measurement' || m.points.length < 2) continue;
    if (excludeMeasurementId && m.id === excludeMeasurementId) continue;

    const mStart = m.points[0];
    const mEnd = m.points[m.points.length - 1];

    const dStartX = endPoint.x - mStart.x;
    const dStartY = endPoint.y - mStart.y;
    const distStartSq = dStartX * dStartX + dStartY * dStartY;
    if (distStartSq <= bestDistSq) {
      best = { line: m, connectToStart: true };
      bestDistSq = distStartSq;
    }

    const dEndX = endPoint.x - mEnd.x;
    const dEndY = endPoint.y - mEnd.y;
    const distEndSq = dEndX * dEndX + dEndY * dEndY;
    if (distEndSq <= bestDistSq) {
      best = { line: m, connectToStart: false };
      bestDistSq = distEndSq;
    }
  }

  return best;
}

function mergePolylineAtEndpoint(
  basePoints: DrawingPoint[],
  baseJoinAtStart: boolean,
  target: { line: DrawingLine; connectToStart: boolean },
): DrawingPoint[] {
  const orientedBase = baseJoinAtStart ? [...basePoints].reverse() : basePoints;
  const orientedTarget = target.connectToStart
    ? target.line.points
    : [...target.line.points].reverse();
  const joint = orientedTarget[0];
  return [
    ...orientedBase.slice(0, -1),
    joint,
    ...orientedTarget.slice(1),
  ];
}

interface ImageEditorProps {
  samModelId: string | null;
  isROIMode: boolean;
  onROIComplete: () => void;
  isCalibrationMode: boolean;
  onCalibrationComplete: () => void;
  calibrationUnit: string;
}

export const ImageEditor: React.FC<ImageEditorProps> = ({ 
  samModelId,
  isROIMode,
  onROIComplete,
  isCalibrationMode,
  onCalibrationComplete,
  calibrationUnit,
}) => {
  const { getCurrentImage, setImages, updateSamROI, updateCalibration } = useMedidor();
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
  // Root-tracing & auto-scan state
  const [isAutoScanning, setIsAutoScanning] = useState(false);
  const [autoScanProgress, setAutoScanProgress] = useState(0);
  const [autoScanMsg, setAutoScanMsg] = useState('');
  const [debugMode, setDebugMode] = useState(false);
  // Trazar mode (phased)
  type TracingPhase = 'idle' | 'computing' | 'pickingMask' | 'editingMask' | 'processing' | 'drawing';
  const [tracingPhase, setTracingPhase] = useState<TracingPhase>('idle');
  const [maskCandidatesResult, setMaskCandidatesResult] = useState<MaskCandidatesResult | null>(null);
  const [selectedMaskCandidate, setSelectedMaskCandidate] = useState<MaskCandidate | null>(null);
  const [editableMask, setEditableMask] = useState<boolean[][] | null>(null);
  const [processedMask, setProcessedMask] = useState<ProcessedMaskResult | null>(null);
  const [maskOverlayData, setMaskOverlayData] = useState<{ dataUrl: string; roi: ROIRegion } | null>(null);
  const [tracingProgress, setTracingProgress] = useState(0);
  const [tracingMsg, setTracingMsg] = useState('');
  const [activeMaskFlow, setActiveMaskFlow] = useState<'trace' | 'auto' | null>(null);
  const [normalTool, setNormalTool] = useState<'draw' | 'erase'>('draw');
  const [isErasingMeasurements, setIsErasingMeasurements] = useState(false);
  const [isMaskPainting, setIsMaskPainting] = useState(false);
  const [erasePreviewPoint, setErasePreviewPoint] = useState<DrawingPoint | null>(null);
  const eraseDraftRef = useRef<DrawingLine[] | null>(null);
  const eraseDidChangeRef = useRef(false);
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
  const [toolsHostEl, setToolsHostEl] = useState<HTMLElement | null>(null);
  const lastImageIdRef = useRef<string | undefined>(undefined);
  // Calibration state
  type CalibrationMode = 'choose' | 'line' | 'rect';
  type CalibrationPhase = 'choosingMode' | 'clickingPoints' | 'inputDimensions' | 'normalizing';
  const [calMode, setCalMode] = useState<CalibrationMode>('choose');
  const [calPhase, setCalPhase] = useState<CalibrationPhase>('choosingMode');
  const [calCorners, setCalCorners] = useState<DrawingPoint[]>([]);
  const [calRealWidth, setCalRealWidth] = useState('');
  const [calRealHeight, setCalRealHeight] = useState('');
  const [calNormalizing, setCalNormalizing] = useState(false);

  useEffect(() => {
    setToolsHostEl(document.getElementById('editor-tools-host'));
  }, []);

  // Current image history helpers
  const imgHistory = currentImage ? historyMap.get(currentImage.id) : undefined;
  const history = useMemo(() => imgHistory?.entries ?? [], [imgHistory]);
  const historyIndex = imgHistory?.index ?? -1;

  // Derived: are embeddings ready for this image + loaded model?
  const embeddingsReady = !!(currentImage?.embeddingsModelId && currentImage.embeddingsModelId === samModelId);

  // Compute embeddings on the current image's ROI crop
  const handleComputeEmbeddings = useCallback(async () => {
    if (!currentImage || !samModelId || !currentImage.samROI || isComputingEmbeddings) return;
    setIsComputingEmbeddings(true);
    setEmbeddingsProgress(0);
    try {
      const alignedROI = getPixelAlignedROI(currentImage.samROI);
      const croppedDataUrl = await cropImageToROI(currentImage.dataUrl, alignedROI);
      // Store the ROI image URL for debug visualizer
      setDebugROIImageUrl(croppedDataUrl);
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

  // Reset calibration state when mode starts
  useEffect(() => {
    if (isCalibrationMode) {
      setCalMode('choose');
      setCalPhase('choosingMode');
      setCalCorners([]);
      setCalRealWidth('');
      setCalRealHeight('');
      setCalNormalizing(false);
    }
  }, [isCalibrationMode]);

  // Calibration completion handler
  // Line calibration handler (2 points, no normalization)
  const handleLineCalibrationComplete = useCallback(() => {
    if (!currentImage || calCorners.length !== 2) return;
    const rLen = parseFloat(calRealWidth);
    if (isNaN(rLen) || rLen <= 0) return;

    const [p0, p1] = calCorners;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const pixelLen = Math.sqrt(dx * dx + dy * dy);
    if (pixelLen < 1) return;
    const ppu = pixelLen / rLen;

    updateCalibration(currentImage.id, {
      imageId: currentImage.id,
      mode: 'line',
      linePoints: [p0, p1],
      realWidth: rLen,
      realHeight: rLen,
      pixelsPerUnitX: ppu,
      pixelsPerUnitY: ppu,
      wasNormalized: false,
      timestamp: Date.now(),
    });
    onCalibrationComplete();
  }, [currentImage, calCorners, calRealWidth, updateCalibration, onCalibrationComplete]);

  // Rect calibration handler (4 corners, perspective correction)
  const handleCalibrationComplete = useCallback(async () => {
    if (!currentImage || calCorners.length !== 4) return;
    const rW = parseFloat(calRealWidth);
    const rH = parseFloat(calRealHeight);
    if (isNaN(rW) || rW <= 0 || isNaN(rH) || rH <= 0) return;

    // Sort the 4 user-clicked points into [TL, TR, BR, BL] order
    const sorted = sortCornersToQuad(calCorners);
    const corners: [DrawingPoint, DrawingPoint, DrawingPoint, DrawingPoint] =
      [sorted[0], sorted[1], sorted[2], sorted[3]];

    setCalNormalizing(true);
    setCalPhase('normalizing');
    try {
      const result = await normalizeImage(currentImage.dataUrl, corners, rW, rH);

      // Transform existing measurement points
      const transformedMeasurements = currentImage.measurements.map(m => {
        const newPoints = m.points.map(p => result.transformPoint(p));
        return { ...m, points: newPoints, pixelLength: calculateTotalDistance(newPoints) };
      });

      setImages(prev => prev.map(img =>
        img.id === currentImage.id ? {
          ...img,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          measurements: transformedMeasurements,
          embeddingsModelId: undefined,
          samROI: undefined,
        } : img
      ));

      updateCalibration(currentImage.id, {
        imageId: currentImage.id,
        mode: 'rect',
        corners,
        realWidth: rW,
        realHeight: rH,
        pixelsPerUnitX: result.pixelsPerUnitX,
        pixelsPerUnitY: result.pixelsPerUnitY,
        wasNormalized: true,
        timestamp: Date.now(),
      });

      // Reset history for this image after normalization
      setHistoryMap(prev => {
        const next = new Map(prev);
        next.delete(currentImage.id);
        return next;
      });
    } catch (err) {
      console.error('Normalization error:', err);
      alert('Error al normalizar la imagen: ' + (err as Error).message);
      setCalNormalizing(false);
      return;
    }
    setCalNormalizing(false);
    onCalibrationComplete();
  }, [currentImage, calCorners, calRealWidth, calRealHeight, setImages, updateCalibration, onCalibrationComplete, setHistoryMap]);

  // History — render-time adjustment pattern
  const saveToHistory = useCallback((imageId: string, measurements: DrawingLine[], h: DrawingLine[][], hIdx: number) => {
    const newEntries = h.slice(0, hIdx + 1);
    newEntries.push(structuredClone(measurements));
    if (newEntries.length > 50) newEntries.shift();
    const newIdx = newEntries.length - 1;
    setHistoryMap(prev => {
      const next = new Map(prev);
      next.set(imageId, { entries: newEntries, index: newIdx });
      return next;
    });
  }, []);

  // Initialize history when image changes (render-time state adjustment)
  const [prevImageId, setPrevImageId] = useState<string | undefined>(undefined);
  const [prevMeasurementsStr, setPrevMeasurementsStr] = useState('');
  if (currentImage?.id !== prevImageId) {
    setPrevImageId(currentImage?.id);
    if (currentImage) {
      if (!historyMap.has(currentImage.id)) {
        const init: DrawingLine[][] = [structuredClone(currentImage.measurements)];
        setHistoryMap(prev => {
          const next = new Map(prev);
          next.set(currentImage.id, { entries: init, index: 0 });
          return next;
        });
      }
      setPrevMeasurementsStr(JSON.stringify(currentImage.measurements));
    }
  }

  // Track external measurement changes (e.g. panel delete)
  const curMeasurementsJson = currentImage ? JSON.stringify(currentImage.measurements) : '';
  if (currentImage && history.length > 0 && curMeasurementsJson !== prevMeasurementsStr) {
    setPrevMeasurementsStr(curMeasurementsJson);
    const histMeasurements = JSON.stringify(history[historyIndex]);
    if (curMeasurementsJson !== histMeasurements) {
      const newEntries = history.slice(0, historyIndex + 1);
      newEntries.push(structuredClone(currentImage.measurements));
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
          ? { ...img, measurements: structuredClone(measurements) }
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
          ? { ...img, measurements: structuredClone(measurements) }
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

      // Draw current drawing
      if (currentPoints.length > 0) {
        const color = tracingPhase === 'drawing' ? '#00897b' : '#FF0000';
        drawLine(ctx, currentPoints, color, tracingPhase === 'drawing' ? 3 : 2);
      }

      // Draw stored ROI rectangle
      if (currentImage.samROI) {
        const roi = getPixelAlignedROI(currentImage.samROI);
        ctx.save();
        ctx.setLineDash([8 / viewScale, 4 / viewScale]);
        ctx.strokeStyle = '#2196F3';
        ctx.lineWidth = 2 / viewScale;
        ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Draw calibration corners & quad
      if (isCalibrationMode && calCorners.length > 0) {
        ctx.save();
        // When 4 corners placed, sort them into proper quad order for drawing
        const drawOrder = calCorners.length === 4
          ? sortCornersToQuad(calCorners)
          : calCorners;
        // Draw lines between corners
        if (drawOrder.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(drawOrder[0].x, drawOrder[0].y);
          for (let i = 1; i < drawOrder.length; i++) {
            ctx.lineTo(drawOrder[i].x, drawOrder[i].y);
          }
          if (drawOrder.length === 4) ctx.closePath();
          ctx.strokeStyle = '#FF8C00';
          ctx.lineWidth = 2.5 / viewScale;
          ctx.setLineDash([8 / viewScale, 4 / viewScale]);
          ctx.stroke();
          ctx.setLineDash([]);
          // Light fill when quad is complete
          if (drawOrder.length === 4) {
            ctx.fillStyle = 'rgba(255, 140, 0, 0.08)';
            ctx.fill();
          }
        }
        // Draw numbered corner circles (in click order)
        calCorners.forEach((corner, idx) => {
          ctx.beginPath();
          ctx.arc(corner.x, corner.y, 8 / viewScale, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 140, 0, 0.5)';
          ctx.fill();
          ctx.strokeStyle = '#FF8C00';
          ctx.lineWidth = 2 / viewScale;
          ctx.stroke();
          // Number label
          const fontSize = Math.max(11, 14 / viewScale);
          ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillStyle = 'white';
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 3 / viewScale;
          ctx.strokeText(String(idx + 1), corner.x, corner.y);
          ctx.fillText(String(idx + 1), corner.x, corner.y);
        });
        ctx.restore();
      }

      // Draw mask overlay when in tracing draw mode
      if (maskOverlayData && tracingPhase === 'drawing') {
        const overlayImg = new Image();
        overlayImg.onload = () => {
          ctx.save();
          ctx.globalAlpha = 0.6;
          ctx.drawImage(overlayImg, maskOverlayData.roi.x, maskOverlayData.roi.y, maskOverlayData.roi.width, maskOverlayData.roi.height);
          ctx.globalAlpha = 1;
          ctx.restore();
        };
        overlayImg.src = maskOverlayData.dataUrl;
      }

      // Draw editable mask overlay directly on canvas while editing
      if (tracingPhase === 'editingMask' && editableMask && currentImage.samROI) {
        const roi = getPixelAlignedROI(currentImage.samROI);
        const maskH = editableMask.length;
        const maskW = editableMask[0]?.length ?? 0;
        if (maskW > 0 && maskH > 0) {
          const scX = roi.width / maskW;
          const scY = roi.height / maskH;
          ctx.save();
          for (let my = 0; my < maskH; my++) {
            for (let mx = 0; mx < maskW; mx++) {
              if (!editableMask[my]?.[mx]) continue;
              const dx = roi.x + mx * scX;
              const dy = roi.y + my * scY;
              ctx.fillStyle = 'rgba(13, 148, 136, 0.34)';
              ctx.fillRect(dx, dy, Math.max(1, scX), Math.max(1, scY));
            }
          }
          ctx.restore();
        }
      }

      // Draw erase brush preview in normal mode
      if (!isROIMode && (tracingPhase === 'idle' || tracingPhase === 'editingMask') && erasePreviewPoint) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(erasePreviewPoint.x, erasePreviewPoint.y, NORMAL_ERASE_BRUSH_RADIUS, 0, Math.PI * 2);
        const previewColor = normalTool === 'draw' ? 'rgba(13, 110, 253, 0.2)' : 'rgba(160, 160, 160, 0.28)';
        ctx.fillStyle = previewColor;
        ctx.fill();
        ctx.strokeStyle = normalTool === 'draw' ? 'rgba(13, 110, 253, 0.8)' : 'rgba(190, 190, 190, 0.85)';
        ctx.lineWidth = 1.5 / viewScale;
        ctx.stroke();
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
  }, [currentImage, currentPoints, tracingPhase, maskOverlayData, viewScale, offsetX, offsetY, canvasWidth, canvasHeight, hoveredEndpoint, drawEndpoint, roiStart, roiCurrent, isROIMode, normalTool, erasePreviewPoint, editableMask, isCalibrationMode, calCorners, calPhase]);

  // Reset view when image changes (defer to next frame)
  const currentImageId = currentImage?.id;
  useEffect(() => {
    if (!currentImageId) {
      lastImageIdRef.current = undefined;
      return;
    }

    if (lastImageIdRef.current && lastImageIdRef.current !== currentImageId) {
      setTracingPhase('idle');
      setMaskCandidatesResult(null);
      setSelectedMaskCandidate(null);
      setEditableMask(null);
      setProcessedMask(null);
      setMaskOverlayData(null);
      setTracingProgress(0);
      setTracingMsg('');
      setIsAutoScanning(false);
      setAutoScanProgress(0);
      setAutoScanMsg('');
      setActiveMaskFlow(null);
      setCurrentPoints([]);
      setExtendingMeasurement(null);
      setHoveredEndpoint(null);
      setIsDrawing(false);
      setIsPanning(false);
      setPanStart(null);
      setRoiStart(null);
      setRoiCurrent(null);
      setNormalTool('draw');
      setErasePreviewPoint(null);

      if (isROIMode) onROIComplete();
    }

    lastImageIdRef.current = currentImageId;
  }, [currentImageId, isROIMode, onROIComplete]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      resetViewToImage();
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageId, canvasWidth, canvasHeight]);

  // Helpers to get positions
  const getCanvasCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  };

  const toImageCoords = (x: number, y: number) => {
    return {
      x: (x - offsetX) / viewScale,
      y: (y - offsetY) / viewScale,
    };
  };

  const applyMaskBrushAtImagePoint = useCallback((point: DrawingPoint) => {
    if (!currentImage?.samROI) return;
    const roi = getPixelAlignedROI(currentImage.samROI);
    if (!editableMask || editableMask.length === 0 || (editableMask[0]?.length ?? 0) === 0) return;

    const maskH = editableMask.length;
    const maskW = editableMask[0].length;

    const relX = point.x - roi.x;
    const relY = point.y - roi.y;
    if (relX < 0 || relY < 0 || relX > roi.width || relY > roi.height) return;

    const mx = Math.floor((relX / Math.max(1, roi.width)) * maskW);
    const my = Math.floor((relY / Math.max(1, roi.height)) * maskH);

    const brushPx = NORMAL_ERASE_BRUSH_RADIUS;
    const rx = Math.max(1, Math.round((brushPx / Math.max(1, roi.width)) * maskW));
    const ry = Math.max(1, Math.round((brushPx / Math.max(1, roi.height)) * maskH));
    const paintValue = normalTool === 'draw';

    setEditableMask(prev => {
      if (!prev) return prev;
      const next = prev.map(row => row.slice());
      const y0 = Math.max(0, my - ry);
      const y1 = Math.min(maskH - 1, my + ry);
      const x0 = Math.max(0, mx - rx);
      const x1 = Math.min(maskW - 1, mx + rx);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const nx = (xx - mx) / rx;
          const ny = (yy - my) / ry;
          if ((nx * nx + ny * ny) <= 1) next[yy][xx] = paintValue;
        }
      }
      return next;
    });
  }, [currentImage, editableMask, normalTool]);

  // Trazar handler — phase 1: compute mask candidates
  const handleStartTracing = useCallback(async () => {
    if (!currentImage || !currentImage.samROI || !embeddingsReady) return;
    if (tracingPhase !== 'idle') {
      // Cancel / reset tracing
      setTracingPhase('idle');
      setMaskCandidatesResult(null);
      setSelectedMaskCandidate(null);
      setEditableMask(null);
      setProcessedMask(null);
      setMaskOverlayData(null);
      setActiveMaskFlow(null);
      setIsAutoScanning(false);
      setAutoScanProgress(0);
      setAutoScanMsg('');
      return;
    }
    setActiveMaskFlow('trace');
    setTracingPhase('computing');
    setTracingProgress(0);
    setTracingMsg('');
    try {
      const result = await computeMaskCandidates(
        currentImage.id,
        currentImage.samROI,
        (pct, msg) => { setTracingProgress(pct); setTracingMsg(msg); },
      );
      setMaskCandidatesResult(result);
      setTracingPhase('pickingMask');
    } catch (err) {
      console.error('Trazar error:', err);
      alert('Error: ' + (err as Error).message);
      setTracingPhase('idle');
      setActiveMaskFlow(null);
    }
  }, [currentImage, embeddingsReady, tracingPhase]);

  // Trazar handler — phase 2: user picked a mask (opens editor)
  const handlePickMask = useCallback((candidate: MaskCandidate) => {
    if (!currentImage || !currentImage.samROI || !maskCandidatesResult) return;
    setSelectedMaskCandidate(candidate);
    setEditableMask(cloneMask(candidate.mask));
    setNormalTool('erase');
    setIsAutoScanning(false);
    setAutoScanProgress(0);
    setAutoScanMsg('');
    setTracingPhase('editingMask');
  }, [currentImage, maskCandidatesResult]);

  // Trazar handler — phase 3: process edited mask
  const handleProcessEditedMask = useCallback(async () => {
    if (!currentImage || !currentImage.samROI || !selectedMaskCandidate || !editableMask || !maskCandidatesResult) return;

    setTracingPhase('processing');
    setTracingProgress(0);
    try {
      const editedArea = editableMask.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
      const result = await processChosenMask(
        {
          ...selectedMaskCandidate,
          mask: editableMask,
          rootArea: editedArea,
          rootPct: editedArea / (selectedMaskCandidate.maskH * selectedMaskCandidate.maskW),
        },
        maskCandidatesResult.roiW,
        maskCandidatesResult.roiH,
        (pct, msg) => {
          if (activeMaskFlow === 'auto') {
            setAutoScanProgress(pct);
            setAutoScanMsg(msg);
          } else {
            setTracingProgress(pct);
            setTracingMsg(msg);
          }
        },
      );

      if (activeMaskFlow === 'auto') {
        const roi = getPixelAlignedROI(currentImage.samROI!);
        const scX = result.maskW / roi.width;
        const scY = result.maskH / roi.height;

        const centerlines: DrawingPoint[][] = result.instances
          .map(inst => inst.skeleton)
          .filter(points => points.length >= 2)
          .map(points => points.map(p => ({
            x: p.x / scX + roi.x,
            y: p.y / scY + roi.y,
          })));

        if (centerlines.length === 0) {
          alert('No se detectaron raíces en el ROI');
          setTracingPhase('idle');
          setMaskCandidatesResult(null);
          setSelectedMaskCandidate(null);
          setEditableMask(null);
          setProcessedMask(null);
          setMaskOverlayData(null);
          setActiveMaskFlow(null);
          setIsAutoScanning(false);
          setAutoScanProgress(0);
          setAutoScanMsg('');
          return;
        }

        const newMeasurements: DrawingLine[] = centerlines.map(points => ({
          id: generateId(),
          points,
          imageId: currentImage.id,
          type: 'measurement' as const,
          pixelLength: calculateTotalDistance(points),
          timestamp: Date.now(),
        }));

        const allMeasurements = [...currentImage.measurements, ...newMeasurements];
        setImages(prev => prev.map(img =>
          img.id === currentImage.id ? { ...img, measurements: allMeasurements } : img
        ));
        saveToHistory(currentImage.id, allMeasurements, history, historyIndex);
        setPrevMeasurementsStr(JSON.stringify(allMeasurements));

        setTracingPhase('idle');
        setMaskCandidatesResult(null);
        setSelectedMaskCandidate(null);
        setEditableMask(null);
        setProcessedMask(null);
        setMaskOverlayData(null);
        setActiveMaskFlow(null);
        setIsAutoScanning(false);
        setAutoScanProgress(0);
        setAutoScanMsg('');
        return;
      }

      setProcessedMask(result);

      // Build mask overlay image (semi-transparent green on root pixels)
      const roi = getPixelAlignedROI(currentImage.samROI!);
      const oCanvas = document.createElement('canvas');
      oCanvas.width = Math.round(roi.width);
      oCanvas.height = Math.round(roi.height);
      const octx = oCanvas.getContext('2d')!;
      const id = octx.createImageData(oCanvas.width, oCanvas.height);
      const px = id.data;
      const scX = result.maskW / oCanvas.width;
      const scY = result.maskH / oCanvas.height;
      for (let y = 0; y < oCanvas.height; y++) {
        const my = Math.min(result.maskH - 1, Math.floor(y * scY));
        for (let x = 0; x < oCanvas.width; x++) {
          const mx = Math.min(result.maskW - 1, Math.floor(x * scX));
          if (result.rootsMask[my]?.[mx]) {
            const idx = (y * oCanvas.width + x) * 4;
            px[idx] = 0; px[idx + 1] = 200; px[idx + 2] = 120; px[idx + 3] = 100;
          }
        }
      }
      octx.putImageData(id, 0, 0);
      setMaskOverlayData({ dataUrl: oCanvas.toDataURL(), roi });

      setMaskCandidatesResult(null);
      setSelectedMaskCandidate(null);
      setEditableMask(null);
      setActiveMaskFlow(null);
      setNormalTool('draw');
      setTracingPhase('drawing');
    } catch (err) {
      console.error('ProcessMask error:', err);
      alert('Error procesando máscara: ' + (err as Error).message);
      setTracingPhase('idle');
      setActiveMaskFlow(null);
      if (isAutoScanning) {
        setIsAutoScanning(false);
        setAutoScanProgress(0);
        setAutoScanMsg('');
      }
    }
  }, [currentImage, selectedMaskCandidate, editableMask, maskCandidatesResult, activeMaskFlow, isAutoScanning, setImages, saveToHistory, history, historyIndex, setPrevMeasurementsStr]);

  // Cancel tracing
  const handleCancelTracing = useCallback(() => {
    setTracingPhase('idle');
    setMaskCandidatesResult(null);
    setSelectedMaskCandidate(null);
    setEditableMask(null);
    setProcessedMask(null);
    setMaskOverlayData(null);
    setActiveMaskFlow(null);
    setIsAutoScanning(false);
    setAutoScanProgress(0);
    setAutoScanMsg('');
  }, []);

  const handleApplyManualErosion = useCallback(() => {
    setEditableMask(prev => {
      if (!prev) return prev;
      return erodeMask(prev, 1);
    });
  }, []);

  const handleRestoreSelectedMask = useCallback(() => {
    if (!selectedMaskCandidate) return;
    setEditableMask(cloneMask(selectedMaskCandidate.mask));
  }, [selectedMaskCandidate]);

  // Auto-scan handler
  const handleAutoScan = useCallback(async () => {
    if (!currentImage || !currentImage.samROI || !embeddingsReady || isAutoScanning || tracingPhase !== 'idle') return;
    setIsAutoScanning(true);
    setAutoScanProgress(0);
    setAutoScanMsg('');
    setActiveMaskFlow('auto');
    setTracingPhase('computing');
    try {
      const result = await computeMaskCandidates(
        currentImage.id,
        currentImage.samROI,
        (pct, msg) => { setAutoScanProgress(pct); setAutoScanMsg(msg); },
      );
      setMaskCandidatesResult(result);
      // Candidate generation is finished; keep UI interactive for mask editing.
      setIsAutoScanning(false);
      setAutoScanProgress(0);
      setAutoScanMsg('');
      setTracingPhase('pickingMask');
    } catch (err) {
      console.error('Auto-scan error:', err);
      alert('Error en auto-escaneo: ' + (err as Error).message);
      setTracingPhase('idle');
      setActiveMaskFlow(null);
      setIsAutoScanning(false);
      setAutoScanProgress(0);
      setAutoScanMsg('');
    }
  }, [currentImage, embeddingsReady, isAutoScanning, tracingPhase]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !currentImage) return;
    if (isAutoScanning || tracingPhase === 'computing' || tracingPhase === 'processing') return;

    const { x, y } = getCanvasCoords(e.clientX, e.clientY);
    const p = toImageCoords(x, y);
    const newPoint = { x: p.x, y: p.y };

    // Calibration mode: click points
    if (isCalibrationMode) {
      if (e.button === 2) {
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
        return;
      }
      const maxPoints = calMode === 'line' ? 2 : 4;
      if (e.button === 0 && calPhase === 'clickingPoints' && calCorners.length < maxPoints) {
        const next = [...calCorners, newPoint];
        setCalCorners(next);
        if (next.length === maxPoints) setCalPhase('inputDimensions');
      }
      return;
    }

    if (tracingPhase === 'editingMask' && e.button === 0) {
      setIsMaskPainting(true);
      applyMaskBrushAtImagePoint(newPoint);
      setErasePreviewPoint(newPoint);
      return;
    }

    if (!isROIMode && tracingPhase === 'idle' && normalTool === 'erase' && e.button === 0) {
      setErasePreviewPoint(newPoint);
      const { next, changed } = eraseFromMeasurements(currentImage.measurements, newPoint, NORMAL_ERASE_BRUSH_RADIUS);
      eraseDraftRef.current = changed ? next : currentImage.measurements;
      eraseDidChangeRef.current = changed;
      setIsErasingMeasurements(true);
      if (changed) {
        setImages((prev) =>
          prev.map((img) =>
            img.id === currentImage.id
              ? { ...img, measurements: next }
              : img
          )
        );
      }
      return;
    }

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

    // Check if clicking on an endpoint (only in measurement mode, not tracing, and draw tool)
    if (tracingPhase !== 'drawing' && normalTool === 'draw') {
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

    const { x, y } = getCanvasCoords(e.clientX, e.clientY);
    const p = toImageCoords(x, y);
    const newPoint = { x: p.x, y: p.y };

    // In calibration mode, nothing to do on move (clicks only)
    if (isCalibrationMode) return;

    if (tracingPhase === 'editingMask') {
      setErasePreviewPoint(newPoint);
      if (isMaskPainting) applyMaskBrushAtImagePoint(newPoint);
      return;
    }

    if (!isROIMode && tracingPhase === 'idle' && normalTool === 'erase') {
      setErasePreviewPoint(newPoint);
    }

    if (isErasingMeasurements && currentImage) {
      const base = eraseDraftRef.current ?? currentImage.measurements;
      const { next, changed } = eraseFromMeasurements(base, newPoint, NORMAL_ERASE_BRUSH_RADIUS);
      if (changed) {
        eraseDraftRef.current = next;
        eraseDidChangeRef.current = true;
        setImages((prev) =>
          prev.map((img) =>
            img.id === currentImage.id
              ? { ...img, measurements: next }
              : img
          )
        );
      }
      return;
    }

    if (erasePreviewPoint) {
      setErasePreviewPoint(null);
    }

    // ROI mode: update rectangle end corner
    if (isROIMode && roiStart) {
      setRoiCurrent(newPoint);
      return;
    }

    // Update hover state (only in measurement mode when not drawing, not tracing)
    if (!isDrawing && tracingPhase !== 'drawing' && currentImage) {
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
      if (extendingMeasurement) {
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
    if (isMaskPainting) {
      setIsMaskPainting(false);
      return;
    }

    // End panning
    if (isPanning) {
      setIsPanning(false);
      setPanStart(null);
      return;
    }

    // Calibration: no mouseUp handling needed (corners added on click)
    if (isCalibrationMode) return;

    // ROI mode: finish rectangle selection
    if (isROIMode && roiStart && roiCurrent && currentImage) {
      const rx = Math.min(roiStart.x, roiCurrent.x);
      const ry = Math.min(roiStart.y, roiCurrent.y);
      const rw = Math.abs(roiCurrent.x - roiStart.x);
      const rh = Math.abs(roiCurrent.y - roiStart.y);
      // Only save if the rectangle has a meaningful size
      if (rw > 5 && rh > 5) {
        clearEmbeddingsCache(currentImage.id);
        updateSamROI(currentImage.id, { x: rx, y: ry, width: rw, height: rh });
      }
      setRoiStart(null);
      setRoiCurrent(null);
      onROIComplete();
      return;
    }

    if (isErasingMeasurements && currentImage) {
      setIsErasingMeasurements(false);
      const draft = eraseDraftRef.current;
      if (draft && eraseDidChangeRef.current) {
        saveToHistory(currentImage.id, draft, history, historyIndex);
        setPrevMeasurementsStr(JSON.stringify(draft));
      }
      eraseDraftRef.current = null;
      eraseDidChangeRef.current = false;
      return;
    }

    if (!isDrawing || !currentImage) return;
    setIsDrawing(false);

    if (currentPoints.length < 2) {
      setCurrentPoints([]);
      setExtendingMeasurement(null);
      return;
    }

    if (extendingMeasurement) {
      const extensionEndpoint = extendingMeasurement.isStart
        ? currentPoints[0]
        : currentPoints[currentPoints.length - 1];
      const mergeTarget = findEndpointMergeTarget(
        currentImage.measurements,
        extensionEndpoint,
        MEASUREMENT_MERGE_THRESHOLD,
        extendingMeasurement.measurementId,
      );

      let updatedMeasurements: DrawingLine[];
      if (mergeTarget) {
        const mergedPoints = mergePolylineAtEndpoint(currentPoints, extendingMeasurement.isStart, mergeTarget);
        const mergedMeasurement: DrawingLine = {
          id: extendingMeasurement.measurementId,
          points: mergedPoints,
          imageId: currentImage.id,
          type: 'measurement',
          pixelLength: calculateTotalDistance(mergedPoints),
          timestamp: Date.now(),
        };

        updatedMeasurements = [
          ...currentImage.measurements.filter(
            (m) => m.id !== extendingMeasurement.measurementId && m.id !== mergeTarget.line.id,
          ),
          mergedMeasurement,
        ];
      } else {
        const pixelLength = calculateTotalDistance(currentPoints);
        updatedMeasurements = currentImage.measurements.map((m) =>
          m.id === extendingMeasurement.measurementId
            ? { ...m, points: currentPoints, pixelLength, timestamp: Date.now() }
            : m
        );
      }
      
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
      /* --- Snap to skeleton when in tracing draw mode --- */
      let finalPoints = currentPoints;
      if (tracingPhase === 'drawing' && processedMask && currentImage.samROI) {
        const roi = getPixelAlignedROI(currentImage.samROI);
        // Convert drawn image-space coords to mask-space
        const scX = processedMask.maskW / roi.width;
        const scY = processedMask.maskH / roi.height;
        const drawnInMask = currentPoints.map(p => ({
          x: (p.x - roi.x) * scX,
          y: (p.y - roi.y) * scY,
        }));
        const snapped = snapToSkeleton(drawnInMask, processedMask.instances);
        if (snapped && snapped.length >= 2) {
          // Convert mask-space coords back to image-space
          finalPoints = snapped.map(p => ({
            x: p.x / scX + roi.x,
            y: p.y / scY + roi.y,
          }));
        }
      }

      const endPoint = finalPoints[finalPoints.length - 1];
      const mergeTarget = findEndpointMergeTarget(
        currentImage.measurements,
        endPoint,
        MEASUREMENT_MERGE_THRESHOLD,
      );

      let newMeasurements: DrawingLine[];
      if (mergeTarget) {
        const mergedPoints = mergePolylineAtEndpoint(finalPoints, false, mergeTarget);

        const mergedMeasurement: DrawingLine = {
          id: generateId(),
          points: mergedPoints,
          imageId: currentImage.id,
          type: 'measurement',
          pixelLength: calculateTotalDistance(mergedPoints),
          timestamp: Date.now(),
        };

        newMeasurements = [
          ...currentImage.measurements.filter((m) => m.id !== mergeTarget.line.id),
          mergedMeasurement,
        ];
      } else {
        const pixelLength = calculateTotalDistance(finalPoints);
        const measurement: DrawingLine = {
          id: generateId(),
          points: finalPoints,
          imageId: currentImage.id,
          type: 'measurement',
          pixelLength,
          timestamp: Date.now(),
        };

        newMeasurements = [...currentImage.measurements, measurement];
      }

      setImages((prev) =>
        prev.map((img) =>
          img.id === currentImage.id
            ? { ...img, measurements: newMeasurements }
            : img
        )
      );
      saveToHistory(currentImage.id, newMeasurements, history, historyIndex);
      setPrevMeasurementsStr(JSON.stringify(newMeasurements));
    }

    setCurrentPoints([]);
    setExtendingMeasurement(null);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !currentImage) return;
    if (isAutoScanning || tracingPhase === 'computing' || tracingPhase === 'processing') return;
    if (e.touches.length === 0) return;
    e.preventDefault();

    if (e.touches.length >= 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      setIsPanning(true);
      setPanStart({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 });
      return;
    }

    const t = e.touches[0];
    const { x, y } = getCanvasCoords(t.clientX, t.clientY);
    const p = toImageCoords(x, y);
    const newPoint = { x: p.x, y: p.y };

    // Calibration mode touch — click points
    if (isCalibrationMode && calPhase === 'clickingPoints') {
      const maxPoints = calMode === 'line' ? 2 : 4;
      if (calCorners.length < maxPoints) {
        const next = [...calCorners, newPoint];
        setCalCorners(next);
        if (next.length === maxPoints) setCalPhase('inputDimensions');
      }
      return;
    }
    if (isCalibrationMode) return;

    if (tracingPhase === 'editingMask') {
      setIsMaskPainting(true);
      setErasePreviewPoint(newPoint);
      applyMaskBrushAtImagePoint(newPoint);
      return;
    }

    if (!isROIMode && tracingPhase === 'idle' && normalTool === 'erase') {
      setErasePreviewPoint(newPoint);
      const { next, changed } = eraseFromMeasurements(currentImage.measurements, newPoint, NORMAL_ERASE_BRUSH_RADIUS);
      eraseDraftRef.current = changed ? next : currentImage.measurements;
      eraseDidChangeRef.current = changed;
      setIsErasingMeasurements(true);
      if (changed) {
        setImages((prev) =>
          prev.map((img) =>
            img.id === currentImage.id
              ? { ...img, measurements: next }
              : img
          )
        );
      }
      return;
    }

    if (isROIMode) {
      setRoiStart(newPoint);
      setRoiCurrent(newPoint);
      return;
    }

    if (tracingPhase !== 'drawing' && normalTool === 'draw') {
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

    setIsDrawing(true);
    setExtendingMeasurement(null);
    setCurrentPoints([newPoint]);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    if (e.touches.length === 0) return;
    e.preventDefault();

    if (e.touches.length >= 2 && isPanning && panStart) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const cx = (t0.clientX + t1.clientX) / 2;
      const cy = (t0.clientY + t1.clientY) / 2;
      const dx = cx - panStart.x;
      const dy = cy - panStart.y;
      setOffsetX(prev => prev + dx);
      setOffsetY(prev => prev + dy);
      setPanStart({ x: cx, y: cy });
      return;
    }

    const t = e.touches[0];
    const { x, y } = getCanvasCoords(t.clientX, t.clientY);
    const p = toImageCoords(x, y);
    const newPoint = { x: p.x, y: p.y };

    // Calibration — no drag needed
    if (isCalibrationMode) return;

    if (tracingPhase === 'editingMask') {
      setErasePreviewPoint(newPoint);
      if (isMaskPainting) applyMaskBrushAtImagePoint(newPoint);
      return;
    }

    if (!isROIMode && tracingPhase === 'idle' && normalTool === 'erase') {
      setErasePreviewPoint(newPoint);
    }

    if (isErasingMeasurements && currentImage) {
      const base = eraseDraftRef.current ?? currentImage.measurements;
      const { next, changed } = eraseFromMeasurements(base, newPoint, NORMAL_ERASE_BRUSH_RADIUS);
      if (changed) {
        eraseDraftRef.current = next;
        eraseDidChangeRef.current = true;
        setImages((prev) =>
          prev.map((img) =>
            img.id === currentImage.id
              ? { ...img, measurements: next }
              : img
          )
        );
      }
      return;
    }

    if (isROIMode && roiStart) {
      setRoiCurrent(newPoint);
      return;
    }

    if (isDrawing) {
      if (extendingMeasurement) {
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

  const handleTouchEnd = async (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.touches.length >= 2) return;
    if (e.touches.length === 1 && isPanning) {
      setIsPanning(false);
      setPanStart(null);
      return;
    }
    if (e.touches.length === 0) {
      if (isMaskPainting) {
        setIsMaskPainting(false);
        return;
      }
      await handleMouseUp();
    }
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

  const toolsPanel = (
    <div className={styles.toolsPanel}>
      {isCalibrationMode && (
        <div className={styles.calibrationSection}>
          {/* Step 1: Choose calibration mode */}
          {calPhase === 'choosingMode' && (
            <>
              <div className={styles.calibrationBanner} style={{
                backgroundColor: 'rgba(255, 140, 0, 0.15)',
                borderColor: '#FF8C00',
              }}>
                📏 Elige el modo de calibración
              </div>
              <button
                className={styles.calModeBtn}
                onClick={() => { setCalMode('line'); setCalPhase('clickingPoints'); }}
              >
                <strong>📐 Línea (2 puntos)</strong>
                <span className={styles.calModeDesc}>Marca una distancia conocida. No modifica la imagen.</span>
              </button>
              <button
                className={styles.calModeBtn}
                onClick={() => { setCalMode('rect'); setCalPhase('clickingPoints'); }}
              >
                <strong>🔲 Rectángulo (4 esquinas)</strong>
                <span className={styles.calModeDesc}>Corrige la perspectiva de la foto usando un rectángulo de referencia.</span>
              </button>
            </>
          )}

          {/* Step 2: Click points */}
          {calPhase === 'clickingPoints' && (
            <>
              <div className={styles.calibrationBanner} style={{
                backgroundColor: 'rgba(255, 140, 0, 0.15)',
                borderColor: '#FF8C00',
              }}>
                {calMode === 'line'
                  ? `📍 Haz clic en los 2 extremos de la referencia (${calCorners.length}/2)`
                  : `📍 Haz clic en las 4 esquinas del rectángulo (${calCorners.length}/4)`}
              </div>
              <div className={styles.calSteps}>
                {Array.from({ length: calMode === 'line' ? 2 : 4 }, (_, i) => (
                  <div
                    key={i}
                    className={`${styles.calStep} ${calCorners.length === i ? styles.calStepActive : ''} ${calCorners.length > i ? styles.calStepDone : ''}`}
                  >
                    <span className={styles.calStepNum}>{i + 1}</span> {calMode === 'line' ? 'Punto' : 'Esquina'}
                  </div>
                ))}
              </div>
              {calCorners.length > 0 && (
                <button
                  className={styles.calRedrawBtn}
                  onClick={() => setCalCorners(prev => prev.slice(0, -1))}
                >
                  ↩ Deshacer último punto
                </button>
              )}
            </>
          )}

          {/* Step 3: Input dimensions */}
          {calPhase === 'inputDimensions' && calMode === 'line' && (
            <div className={styles.calInputRow}>
              <div className={styles.calibrationBanner} style={{
                backgroundColor: 'rgba(33, 150, 243, 0.15)',
                borderColor: '#2196F3',
              }}>
                📐 Introduce la longitud real de la línea
              </div>
              <label className={styles.calInputLabel}>
                Longitud real ({calibrationUnit}):
                <input
                  type="number"
                  className={styles.calInput}
                  value={calRealWidth}
                  onChange={(e) => setCalRealWidth(e.target.value)}
                  placeholder="ej. 30"
                  min="0"
                  step="any"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && parseFloat(calRealWidth) > 0) handleLineCalibrationComplete();
                    if (e.key === 'Escape') onCalibrationComplete();
                  }}
                />
              </label>
              <div className={styles.calInputActions}>
                <button
                  className={styles.calNextBtn}
                  onClick={handleLineCalibrationComplete}
                  disabled={!calRealWidth || parseFloat(calRealWidth) <= 0}
                >
                  ✓ Calibrar
                </button>
                <button
                  className={styles.calRedrawBtn}
                  onClick={() => { setCalCorners([]); setCalRealWidth(''); setCalPhase('clickingPoints'); }}
                >
                  Redibujar
                </button>
              </div>
            </div>
          )}

          {calPhase === 'inputDimensions' && calMode === 'rect' && (
            <div className={styles.calInputRow}>
              <div className={styles.calibrationBanner} style={{
                backgroundColor: 'rgba(33, 150, 243, 0.15)',
                borderColor: '#2196F3',
              }}>
                📐 Introduce las dimensiones reales del rectángulo
              </div>
              <label className={styles.calInputLabel}>
                Ancho real ({calibrationUnit}):
                <input
                  type="number"
                  className={styles.calInput}
                  value={calRealWidth}
                  onChange={(e) => setCalRealWidth(e.target.value)}
                  placeholder="ej. 21"
                  min="0"
                  step="any"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') onCalibrationComplete();
                  }}
                />
              </label>
              <label className={styles.calInputLabel}>
                Alto real ({calibrationUnit}):
                <input
                  type="number"
                  className={styles.calInput}
                  value={calRealHeight}
                  onChange={(e) => setCalRealHeight(e.target.value)}
                  placeholder="ej. 29.7"
                  min="0"
                  step="any"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && parseFloat(calRealWidth) > 0 && parseFloat(calRealHeight) > 0) {
                      handleCalibrationComplete();
                    }
                    if (e.key === 'Escape') onCalibrationComplete();
                  }}
                />
              </label>
              <div className={styles.calInputActions}>
                <button
                  className={styles.calNextBtn}
                  onClick={handleCalibrationComplete}
                  disabled={!calRealWidth || parseFloat(calRealWidth) <= 0 || !calRealHeight || parseFloat(calRealHeight) <= 0 || calNormalizing}
                >
                  ✓ Calibrar
                </button>
                <button
                  className={styles.calRedrawBtn}
                  onClick={() => { setCalCorners([]); setCalRealWidth(''); setCalRealHeight(''); setCalPhase('clickingPoints'); }}
                >
                  Redibujar esquinas
                </button>
              </div>
            </div>
          )}

          {calPhase === 'normalizing' && (
            <div className={styles.calibrationBanner} style={{
              backgroundColor: 'rgba(33, 150, 243, 0.15)',
              borderColor: '#2196F3',
            }}>
              ⏳ Corrigiendo perspectiva…
            </div>
          )}

          <button
            className={styles.calCancelBtn}
            onClick={onCalibrationComplete}
            disabled={calNormalizing}
          >
            Cancelar calibración
          </button>
        </div>
      )}

      {isROIMode && !isCalibrationMode && (
        <div className={styles.calibrationBanner} style={{ backgroundColor: 'rgba(33, 150, 243, 0.15)', borderColor: '#2196F3' }}>
          🔲 Modo ROI: Arrastra para definir la región de interés
        </div>
      )}
      {tracingPhase === 'drawing' && !isROIMode && (
        <div className={styles.calibrationBanner} style={{ backgroundColor: 'rgba(0, 137, 123, 0.15)', borderColor: '#00897b' }}>
          🌱 Dibuja sobre las raíces — la medición se ajustará al esqueleto más cercano
        </div>
      )}

      <div className={styles.toolsSections}>
        <div className={styles.toolSection}>
          <div className={styles.sectionTitle}>Dibujo</div>
          <div className={styles.toolbar}>
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
            <button className={styles.toolbarButton} onClick={handleResetView} title="Restablecer vista (zoom/pan) - Atajo: R">
              🔍 {Math.round(viewScale * 100)}%
            </button>
            <div className={styles.normalToolGroup}>
              <button
                className={`${styles.toolbarButton} ${normalTool === 'draw' ? styles.activeMode : ''}`}
                onClick={() => setNormalTool('draw')}
                title="Modo normal: dibujar mediciones"
              >
                ✏️ Pintar
              </button>
              <button
                className={`${styles.toolbarButton} ${normalTool === 'erase' ? styles.activeMode : ''}`}
                onClick={() => setNormalTool('erase')}
                title="Modo normal: borrar tramos de mediciones existentes"
              >
                🧽 Borrar
              </button>
            </div>
          </div>
        </div>

        <div className={styles.toolSection}>
          <div className={styles.sectionTitle}>IA</div>
          <div className={styles.toolbar}>
            <button
              className={`${styles.embeddingsBtn} ${embeddingsReady ? styles.activeMode : ''}`}
              onClick={handleComputeEmbeddings}
              disabled={!samModelId || !currentImage.samROI || isComputingEmbeddings || (tracingPhase !== 'idle' && tracingPhase !== 'editingMask')}
              title={
                isComputingEmbeddings
                  ? `Calculando... ${Math.round(embeddingsProgress ?? 0)}%`
                  : embeddingsReady
                    ? 'Embeddings listos para esta imagen/ROI'
                    : 'Calcular embeddings IA sobre el ROI'
              }
            >
              {isComputingEmbeddings
                ? `🧠 ${Math.round(embeddingsProgress ?? 0)}%`
                : embeddingsReady
                  ? '🧠 Listos'
                  : '🧠 Calcular'}
            </button>
            <button
              className={`${styles.toolbarButton} ${tracingPhase !== 'idle' ? styles.activeMode : ''}`}
              onClick={handleStartTracing}
              disabled={!embeddingsReady || isAutoScanning || tracingPhase === 'computing' || tracingPhase === 'processing' || tracingPhase === 'editingMask'}
              title={tracingPhase === 'idle' ? 'Trazar: segmentar y medir raíces' : 'Cancelar trazado'}
            >
              {tracingPhase === 'computing' || tracingPhase === 'processing'
                ? `🌱 ${tracingProgress}%`
                : tracingPhase !== 'idle' ? '✕ Cancelar' : '🌱 Trazar'}
            </button>
            <button
              className={styles.toolbarButton}
              onClick={handleAutoScan}
              disabled={!embeddingsReady || isAutoScanning || tracingPhase !== 'idle'}
              title="Escanear automáticamente el ROI buscando raíces"
            >
              {isAutoScanning ? `🔍 ${autoScanProgress}%` : '🔍 Auto'}
            </button>
            {tracingPhase === 'editingMask' && (
              <>
                <button className={styles.toolbarButton} onClick={handleApplyManualErosion}>
                  Erosión
                </button>
                <button className={styles.toolbarButton} onClick={handleRestoreSelectedMask}>
                  Restaurar
                </button>
                <button className={`${styles.toolbarButton} ${styles.activeMode}`} onClick={handleProcessEditedMask}>
                  Usar máscara
                </button>
                <button className={styles.toolbarButton} onClick={handleCancelTracing}>
                  Cancelar
                </button>
              </>
            )}
            <button
              className={`${styles.debugTiny} ${debugMode ? styles.debugTinyActive : ''}`}
              onClick={() => { const next = !debugMode; setDebugMode(next); setDebugEnabled(next); }}
              title="Debug SAM"
            >
              debug
            </button>
          </div>
        </div>
      </div>

      {(isComputingEmbeddings || isAutoScanning || tracingPhase === 'computing' || tracingPhase === 'processing') && (
        <div className={styles.toolsStatus}>
          {isComputingEmbeddings && (
            <div className={styles.statusLine}>🧠 Embeddings: {Math.round(embeddingsProgress ?? 0)}%</div>
          )}
          {isAutoScanning && (
            <div className={styles.statusLine}>🔍 {autoScanMsg || 'Escaneando…'} ({autoScanProgress}%)</div>
          )}
          {(tracingPhase === 'computing' || tracingPhase === 'processing') && (
            <div className={styles.statusLine}>🌱 {tracingMsg || 'Procesando…'} ({tracingProgress}%)</div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.editor}>
      {toolsHostEl ? createPortal(toolsPanel, toolsHostEl) : toolsPanel}

      {/* Mask picker overlay — phase: pickingMask */}
      {tracingPhase === 'pickingMask' && maskCandidatesResult && (
        <div className={styles.maskPickerOverlay}>
          <div className={styles.maskPickerPanel}>
            <h3 style={{ margin: '0 0 8px', color: '#e0e0e0' }}>Elige la máscara que mejor segmente las raíces</h3>
            <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: '#aaa' }}>
              Las zonas verdes representan las raíces detectadas. Haz clic en la mejor.
            </p>
            <div className={styles.maskPickerCards}>
              {maskCandidatesResult.candidates.map((cand, i) => (
                <button
                  key={cand.idx}
                  className={styles.maskPickerCard}
                  onClick={() => handlePickMask(cand)}
                  title={`Máscara ${cand.idx + 1}: ${(cand.rootPct * 100).toFixed(1)}% raíces, ${cand.numComps} componentes`}
                >
                  <MaskThumbnail candidate={cand} roiW={maskCandidatesResult.roiW} roiH={maskCandidatesResult.roiH} />
                  <span className={styles.maskPickerLabel}>
                    {i < 3 ? 'A' : 'B'}{(i % 3) + 1} — {(cand.rootPct * 100).toFixed(1)}%
                  </span>
                  <span className={styles.maskPickerSub}>
                    {cand.numComps} comp · IoU {cand.iouScore.toFixed(2)}
                  </span>
                </button>
              ))}
            </div>
            <button className={styles.toolbarButton} onClick={handleCancelTracing} style={{ marginTop: 12 }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className={styles.canvasContainer} ref={containerRef}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { setErasePreviewPoint(null); void handleMouseUp(); }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          onContextMenu={(e) => e.preventDefault()}
          style={{ 
            cursor: (isAutoScanning || tracingPhase === 'computing' || tracingPhase === 'processing' || calNormalizing)
              ? 'wait'
              : isCalibrationMode && calPhase === 'clickingPoints'
              ? 'crosshair'
              : isROIMode
              ? 'crosshair'
              : (!isROIMode && normalTool === 'erase' && (tracingPhase === 'idle' || tracingPhase === 'editingMask'))
                      ? 'none'
              : tracingPhase === 'drawing'
              ? 'crosshair'
              : (isPanning ? 'grabbing' : (isDrawing ? 'crosshair' : (hoveredEndpoint ? 'grab' : 'default')))
          }}
        />
      </div>
    </div>
  );
};

/** Renders a small canvas thumbnail of an inverted mask candidate. */
const MaskThumbnail: React.FC<{ candidate: MaskCandidate; roiW: number; roiH: number }> = ({ candidate, roiW, roiH }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const maxW = 180;
    const scale = Math.min(1, maxW / roiW);
    c.width = Math.round(roiW * scale);
    c.height = Math.round(roiH * scale);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, c.width, c.height);

    const scX = roiW / candidate.maskW;
    const scY = roiH / candidate.maskH;
    for (let my = 0; my < candidate.maskH; my++) {
      for (let mx = 0; mx < candidate.maskW; mx++) {
        if (candidate.mask[my]?.[mx]) {
          const dx = Math.floor(mx * scX * scale);
          const dy = Math.floor(my * scY * scale);
          const dw = Math.max(1, Math.ceil(scX * scale));
          const dh = Math.max(1, Math.ceil(scY * scale));
          ctx.fillStyle = 'rgba(0, 200, 120, 0.7)';
          ctx.fillRect(dx, dy, dw, dh);
        }
      }
    }
  }, [candidate, roiW, roiH]);

  return <canvas ref={canvasRef} style={{ borderRadius: 4, display: 'block' }} />;
};
