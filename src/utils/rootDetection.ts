/**
 * Aplica una operación de cerrado morfológico (dilatación seguida de erosión) a una imagen binaria
 * para rellenar huecos pequeños y unir fragmentos cercanos.
 */
export function morphologicalClosing(imageData: ImageData, radius: number = 2): ImageData {
  // Dilatación
  const dilated = new ImageData(imageData.width, imageData.height);
  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      let foundWhite = false;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < imageData.width && ny >= 0 && ny < imageData.height) {
            const idx = (ny * imageData.width + nx) * 4;
            if (imageData.data[idx] === 255) {
              foundWhite = true;
              break;
            }
          }
        }
        if (foundWhite) break;
      }
      const outIdx = (y * imageData.width + x) * 4;
      const value = foundWhite ? 255 : 0;
      dilated.data[outIdx] = value;
      dilated.data[outIdx + 1] = value;
      dilated.data[outIdx + 2] = value;
      dilated.data[outIdx + 3] = 255;
    }
  }
  // Erosión
  const eroded = new ImageData(imageData.width, imageData.height);
  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      let allWhite = true;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < imageData.width && ny >= 0 && ny < imageData.height) {
            const idx = (ny * imageData.width + nx) * 4;
            if (dilated.data[idx] !== 255) {
              allWhite = false;
              break;
            }
          } else {
            allWhite = false;
            break;
          }
        }
        if (!allWhite) break;
      }
      const outIdx = (y * imageData.width + x) * 4;
      const value = allWhite ? 255 : 0;
      eroded.data[outIdx] = value;
      eroded.data[outIdx + 1] = value;
      eroded.data[outIdx + 2] = value;
      eroded.data[outIdx + 3] = 255;
    }
  }
  return eroded;
}
/**
 * Utilidades para detección automática de raíces mediante visión artificial
 */

export interface HistogramData {
  bins: number[];
  min: number;
  max: number;
  total: number;
}

/**
 * Convierte una imagen a escala de grises y genera un histograma
 */
export const analyzeImageHistogram = (imageData: ImageData): HistogramData => {
  const data = imageData.data;
  const histogram = new Array(256).fill(0);
  
  // Convertir cada píxel a escala de grises usando luminancia
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    // Fórmula de luminancia (percepción humana)
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    histogram[gray]++;
  }
  
  const total = imageData.width * imageData.height;
  
  return {
    bins: histogram,
    min: 0,
    max: 255,
    total
  };
};

/**
 * Encuentra los picos principales en el histograma
 */
export const findHistogramPeaks = (histogram: HistogramData, minProminence: number = 0.05): number[] => {
  const peaks: number[] = [];
  const threshold = histogram.total * minProminence;
  
  for (let i = 1; i < histogram.bins.length - 1; i++) {
    const current = histogram.bins[i];
    const prev = histogram.bins[i - 1];
    const next = histogram.bins[i + 1];
    
    // Es un pico local si es mayor que sus vecinos y supera el umbral
    if (current > prev && current > next && current > threshold) {
      peaks.push(i);
    }
  }
  
  return peaks;
};

/**
 * Dibuja el histograma en un canvas (para debug/visualización)
 */
export const drawHistogram = (
  ctx: CanvasRenderingContext2D,
  histogram: HistogramData,
  width: number,
  height: number,
  thresholds?: { min: number; max: number }
) => {
  const maxCount = Math.max(...histogram.bins);
  const barWidth = width / histogram.bins.length;
  
  ctx.fillStyle = '#333';
  ctx.fillRect(0, 0, width, height);
  
  ctx.fillStyle = '#4CAF50';
  histogram.bins.forEach((count, i) => {
    const barHeight = (count / maxCount) * height;
    const x = i * barWidth;
    const y = height - barHeight;
    ctx.fillRect(x, y, barWidth, barHeight);
  });
  
  // Dibujar picos si existen
  const peaks = findHistogramPeaks(histogram);
  ctx.fillStyle = '#FF5252';
  peaks.forEach(peak => {
    const x = peak * barWidth;
    const barHeight = (histogram.bins[peak] / maxCount) * height;
    const y = height - barHeight;
    ctx.fillRect(x, y - 5, barWidth, 5);
  });
  
  // Dibujar líneas de umbral si existen
  if (thresholds) {
    // Umbral mínimo (amarillo)
    ctx.strokeStyle = '#FFC107';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const xMin = thresholds.min * barWidth;
    ctx.moveTo(xMin, 0);
    ctx.lineTo(xMin, height);
    ctx.stroke();
    
    // Umbral máximo (naranja)
    ctx.strokeStyle = '#FF6D00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const xMax = thresholds.max * barWidth;
    ctx.moveTo(xMax, 0);
    ctx.lineTo(xMax, height);
    ctx.stroke();
  }
};

/**
 * Aplica el operador Sobel para detectar bordes
 */
export const applySobel = (imageData: ImageData): ImageData => {
  const width = imageData.width;
  const height = imageData.height;
  const result = new ImageData(width, height);
  const data = imageData.data;
  const resultData = result.data;
  
  // Kernels de Sobel
  const sobelX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
  const sobelY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0;
      let gy = 0;
      
      // Aplicar kernels
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = ((y + ky) * width + (x + kx)) * 4;
          const pixel = data[idx]; // Usar solo canal rojo (ya está en escala de grises)
          gx += pixel * sobelX[ky + 1][kx + 1];
          gy += pixel * sobelY[ky + 1][kx + 1];
        }
      }
      
      // Magnitud del gradiente
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      const value = Math.min(255, magnitude);
      
      const idx = (y * width + x) * 4;
      resultData[idx] = value;
      resultData[idx + 1] = value;
      resultData[idx + 2] = value;
      resultData[idx + 3] = 255;
    }
  }
  
  return result;
};

/**
 * Detecta componentes conexos en la imagen binaria
 */
export const findConnectedComponents = (imageData: ImageData): Array<Array<{ x: number; y: number }>> => {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  const visited = new Array(width * height).fill(false);
  const components: Array<Array<{ x: number; y: number }>> = [];
  
  const isWhite = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * 4;
    return data[idx] > 128;
  };
  
  const floodFill = (startX: number, startY: number): Array<{ x: number; y: number }> => {
    const component: Array<{ x: number; y: number }> = [];
    const queue: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];
    
    while (queue.length > 0) {
      const { x, y } = queue.shift()!;
      const idx = y * width + x;
      
      if (visited[idx]) continue;
      if (!isWhite(x, y)) continue;
      
      visited[idx] = true;
      component.push({ x, y });
      
      // 8-conectividad
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nidx = ny * width + nx;
            if (!visited[nidx] && isWhite(nx, ny)) {
              queue.push({ x: nx, y: ny });
            }
          }
        }
      }
    }
    
    return component;
  };
  
  // Buscar componentes
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!visited[idx] && isWhite(x, y)) {
        const component = floodFill(x, y);
        // Filtrar componentes pequeños (ruido)
        if (component.length > 100) {
          components.push(component);
        }
      }
    }
  }
  
  return components;
};

/**
 * Traza una línea siguiendo el centro de un componente verticalmente
 */
export const traceVerticalLine = (component: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
  // Agrupar píxeles por fila (y)
  const rowMap = new Map<number, Array<number>>();
  
  for (const point of component) {
    if (!rowMap.has(point.y)) {
      rowMap.set(point.y, []);
    }
    rowMap.get(point.y)!.push(point.x);
  }
  
  // Calcular el centro de cada fila
  const centerPoints: Array<{ x: number; y: number }> = [];
  const sortedRows = Array.from(rowMap.keys()).sort((a, b) => a - b);
  
  for (const y of sortedRows) {
    const xValues = rowMap.get(y)!;
    const centerX = xValues.reduce((sum, x) => sum + x, 0) / xValues.length;
    centerPoints.push({ x: Math.round(centerX), y });
  }
  
  // Suavizar la línea (cada 5 puntos promediados)
  const smoothed: Array<{ x: number; y: number }> = [];
  const windowSize = 10;
  
  for (let i = 0; i < centerPoints.length; i += windowSize) {
    const window = centerPoints.slice(i, Math.min(i + windowSize, centerPoints.length));
    const avgX = window.reduce((sum, p) => sum + p.x, 0) / window.length;
    const avgY = window.reduce((sum, p) => sum + p.y, 0) / window.length;
    smoothed.push({ x: Math.round(avgX), y: Math.round(avgY) });
  }
  
  return smoothed;
};

/**
 * Aplica umbralización con rango (mín y máx) a la imagen
 */
export const applyThresholdRange = (
  imageData: ImageData,
  minThreshold: number,
  maxThreshold: number
): ImageData => {
  const result = new ImageData(imageData.width, imageData.height);
  const data = imageData.data;
  const resultData = result.data;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    // Convertir a escala de grises
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    
    // Aplicar umbral: blanco si está en el rango, negro si no
    const value = (gray > minThreshold && gray < maxThreshold) ? 255 : 0;
    
    resultData[i] = value;
    resultData[i + 1] = value;
    resultData[i + 2] = value;
    resultData[i + 3] = 255; // Alpha
  }
  
  return result;
};

/**
 * Aplica umbralización a la imagen
 */
export const applyThreshold = (
  imageData: ImageData,
  threshold: number
): ImageData => {
  const result = new ImageData(imageData.width, imageData.height);
  const data = imageData.data;
  const resultData = result.data;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    // Convertir a escala de grises
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    
    // Aplicar umbral: blanco si está por encima, negro si no
    const value = gray > threshold ? 255 : 0;
    
    resultData[i] = value;
    resultData[i + 1] = value;
    resultData[i + 2] = value;
    resultData[i + 3] = 255; // Alpha
  }
  
  return result;
};

/**
 * Calcula los umbrales óptimos (mínimo y máximo) basado en el histograma
 */
export const calculateOptimalThreshold = (histogram: HistogramData): { min: number; max: number } => {
  const peaks = findHistogramPeaks(histogram, 0.02);
  
  if (peaks.length === 0) {
    // Si no hay picos, usar valores por defecto
    return { min: 128, max: 255 };
  }
  
  // Encontrar el pico principal (el que tiene más píxeles - normalmente el fondo)
  const sortedPeaks = peaks.sort((a, b) => histogram.bins[b] - histogram.bins[a]);
  const mainPeak = sortedPeaks[0];
  
  // UMBRAL MÍNIMO: Buscar donde termina el pico principal hacia la derecha
  const peakHeight = histogram.bins[mainPeak];
  const threshold_percentage = 0.05; // 5% del pico (más bajo)
  const minHeight = peakHeight * threshold_percentage;
  
  let endOfPeak = mainPeak;
  for (let i = mainPeak + 1; i < histogram.bins.length; i++) {
    if (histogram.bins[i] < minHeight) {
      endOfPeak = i;
      break;
    }
    if (histogram.bins[i] > minHeight) {
      endOfPeak = i;
    }
  }
  
  const minThreshold = Math.min(endOfPeak, 255);
  
  // UMBRAL MÁXIMO: Buscar desde la derecha donde empiezan los reflejos (píxeles muy blancos)
  // Recorremos desde el final hasta encontrar donde la frecuencia es casi cero
  const noiseThreshold = histogram.total * 0.0001; // 0.01% de los píxeles
  
  let maxThreshold = 255;
  for (let i = 254; i >= minThreshold; i--) {
    if (histogram.bins[i] > noiseThreshold) {
      maxThreshold = i;
      break;
    }
  }
  
  // Restar un margen mayor para asegurar que descartamos reflejos
  maxThreshold = Math.max(maxThreshold - 25, minThreshold + 10);
  
  return { min: minThreshold, max: maxThreshold };
};

/**
 * Detecta raíces en la imagen
 */
export const detectRoots = async (
  canvas: HTMLCanvasElement,
  onProgress?: (message: string) => void
): Promise<{ 
  lines: Array<{ points: Array<{ x: number; y: number }> }>;
  histogram: HistogramData;
  thresholds: { min: number; max: number };
  thresholdedImage: ImageData;
  edgesImage: ImageData;
}> => {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo obtener contexto 2D');
  
  onProgress?.('Analizando histograma...');
  
  // Obtener datos de la imagen
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = analyzeImageHistogram(imageData);
  
  // Encontrar picos (representan fondo y raíces)
  const peaks = findHistogramPeaks(histogram, 0.02);
  
  // Calcular umbrales óptimos (mín y máx)
  const thresholds = calculateOptimalThreshold(histogram);
  
  onProgress?.('Aplicando umbralización...');
  
  // Aplicar umbral con rango

  // Máscara binaria original
  const thresholdedImage = applyThresholdRange(imageData, thresholds.min, thresholds.max);

  // Máscara cerrada para unir fragmentos de raíz (solo para componentes)
  onProgress?.('Aplicando cerrado morfológico...');
  const closedImage = morphologicalClosing(thresholdedImage, 2);

  onProgress?.('Detectando bordes...');

  // Detectar bordes con Sobel (sobre la máscara cerrada para visualización)
  const edgesImage = applySobel(closedImage);

  onProgress?.('Encontrando componentes conexos...');

  // Detectar componentes conexos (raíces individuales) sobre la máscara cerrada
  const components = findConnectedComponents(closedImage);

  onProgress?.('Trazando líneas de raíces...');

  // Trazar línea central para cada componente, usando la máscara binaria original
  // (esto preserva detalles finos en el trazo)
  const lines = components.map(component => ({
    points: traceVerticalLine(component)
  }));
  
  console.log('Histograma generado:', {
    total: histogram.total,
    picos: peaks,
    distribucion: peaks.map(p => ({
      valor: p,
      pixeles: histogram.bins[p],
      porcentaje: ((histogram.bins[p] / histogram.total) * 100).toFixed(2) + '%'
    })),
    umbralMin: thresholds.min,
    umbralMax: thresholds.max
  });
  
  console.log('Raíces detectadas:', {
    componentes: components.length,
    lineas: lines.length,
    puntosPromedio: lines.length > 0 ? 
      lines.reduce((sum, line) => sum + line.points.length, 0) / lines.length : 0
  });
  
  onProgress?.(`Detectadas ${lines.length} raíces con ${lines.reduce((sum, l) => sum + l.points.length, 0)} puntos totales`);
  
  return {
    lines,
    histogram,
    thresholds,
    thresholdedImage,
    edgesImage
  };
};
