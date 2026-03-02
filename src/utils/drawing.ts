import type { DrawingPoint } from '../types';

export function calculateDistance(p1: DrawingPoint, p2: DrawingPoint): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

export function calculateTotalDistance(points: DrawingPoint[]): number {
  if (points.length < 2) return 0;
  
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += calculateDistance(points[i], points[i + 1]);
  }
  return total;
}

/**
 * Calculate the real-world length of a polyline using 2D calibration.
 * Each segment is converted to real units before computing its length,
 * handling potential non-uniform scaling between X and Y axes.
 */
export function calculateTotalRealDistance(
  points: DrawingPoint[],
  pixelsPerUnitX: number,
  pixelsPerUnitY: number,
): number {
  if (points.length < 2) return 0;

  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dxReal = (points[i + 1].x - points[i].x) / pixelsPerUnitX;
    const dyReal = (points[i + 1].y - points[i].y) / pixelsPerUnitY;
    total += Math.sqrt(dxReal * dxReal + dyReal * dyReal);
  }
  return total;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Smooth a polyline using a Gaussian-weighted moving average.
 * Removes high-frequency jitter from hand-drawn input while
 * preserving the overall shape and start/end points.
 *
 * @param points  Raw polyline.
 * @param radius  Half-window size (default 3 → window of 7 samples).
 * @param passes  Number of smoothing iterations (default 2).
 */
export function smoothPolyline(
  points: DrawingPoint[],
  radius = 3,
  passes = 2,
): DrawingPoint[] {
  if (points.length < 3) return points;

  // Pre-compute Gaussian kernel for the given radius
  const sigma = radius / 2;
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  let src = points;
  for (let pass = 0; pass < passes; pass++) {
    const out: DrawingPoint[] = new Array(src.length);
    // Keep endpoints fixed
    out[0] = src[0];
    out[src.length - 1] = src[src.length - 1];
    for (let i = 1; i < src.length - 1; i++) {
      let sx = 0, sy = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = Math.min(Math.max(i + k, 0), src.length - 1);
        const w = kernel[k + radius];
        sx += src[j].x * w;
        sy += src[j].y * w;
      }
      out[i] = { x: sx, y: sy };
    }
    src = out;
  }
  return src;
}

export function downloadCSV(data: Record<string, string | number>[], filename: string = 'mediciones.csv'): void {
  const headers = Object.keys(data[0] || {});
  
  // Usar punto y coma como separador (formato CSV estándar para Excel en español)
  const csvContent = [
    headers.join(';'),
    ...data.map(row => headers.map(header => {
      const value = row[header];
      if (value === undefined || value === null) return '';
      // Reemplazar punto decimal por coma para Excel en español
      if (typeof value === 'number') {
        return value.toString().replace('.', ',');
      }
      return value;
    }).join(';'))
  ].join('\n');

  // Agregar BOM UTF-8 para que Excel reconozca correctamente los caracteres especiales
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function drawLine(
  ctx: CanvasRenderingContext2D,
  points: DrawingPoint[],
  strokeStyle: string = '#FF0000',
  lineWidth: number = 2
): void {
  if (points.length < 2) return;

  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }

  ctx.stroke();
}