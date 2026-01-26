/**
 * SAM (Segment Anything Model) Instance Segmentation Utility
 * This module provides functionality to perform instance segmentation on images
 * to detect and segment individual roots.
 */

import * as ort from 'onnxruntime-web';

export interface Point {
  x: number;
  y: number;
}

export interface InstanceMask {
  id: string;
  mask: Uint8ClampedArray; // Binary mask (0 or 255)
  width: number;
  height: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  area: number;
  centroid: Point;
  confidence: number;
}

export interface SegmentationResult {
  instances: InstanceMask[];
  totalInstances: number;
  processingTime: number;
}

/**
 * Configuration for root detection
 * Adjust these parameters based on your specific image characteristics
 */
export interface SegmentationConfig {
  // Brightness threshold (0-1): what percentage of brightness range is considered "white"
  brightnessPercentile: number;
  // Minimum aspect ratio for elongated structures
  minAspectRatio: number;
  // Minimum area in pixels
  minArea: number;
  // Maximum solidity (area/bbox_area) - lower values = more irregular shapes
  maxSolidity: number;
  // Minimum circularity inverse - higher values = more elongated
  minCircularityInverse: number;
}

const DEFAULT_CONFIG: SegmentationConfig = {
  brightnessPercentile: 0.6, // Top 40% of brightness
  minAspectRatio: 2.5,
  minArea: 200,
  maxSolidity: 0.8,
  minCircularityInverse: 3.0
};

// SAM Model Configuration
interface SAMModelConfig {
  encoderPath: string;
  decoderPath: string;
  imageSize: number;
}

const SAM_MODEL_CONFIG: SAMModelConfig = {
  encoderPath: '/models/sam_vit_b_encoder_quantized.onnx',
  decoderPath: '/models/sam_vit_b_decoder_quantized.onnx',
  imageSize: 1024
};

// SAM Model Manager
class SAMModelManager {
  private encoderSession: ort.InferenceSession | null = null;
  private decoderSession: ort.InferenceSession | null = null;
  private isLoading: boolean = false;
  private imageEmbedding: ort.Tensor | null = null;
  private lastImageData: ImageData | null = null;

  async loadModel(): Promise<boolean> {
    if (this.encoderSession && this.decoderSession) return true;
    if (this.isLoading) return false;

    try {
      this.isLoading = true;
      console.log('Loading SAM model...');
      
      // Configure ONNX Runtime
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/';
      ort.env.wasm.numThreads = 4;
      
      // Try to load both encoder and decoder
      console.log('Loading encoder:', SAM_MODEL_CONFIG.encoderPath);
      this.encoderSession = await ort.InferenceSession.create(
        SAM_MODEL_CONFIG.encoderPath,
        {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        }
      );
      
      console.log('Loading decoder:', SAM_MODEL_CONFIG.decoderPath);
      this.decoderSession = await ort.InferenceSession.create(
        SAM_MODEL_CONFIG.decoderPath,
        {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        }
      );
      
      console.log('✓ SAM model loaded successfully!');
      this.isLoading = false;
      return true;
    } catch (error) {
      console.warn('Failed to load SAM model:', error);
      console.warn('Falling back to computer vision method');
      this.encoderSession = null;
      this.decoderSession = null;
      this.isLoading = false;
      return false;
    }
  }

  async runInference(
    imageData: ImageData,
    promptPoints: Point[]
  ): Promise<Uint8ClampedArray | null> {
    if (!this.encoderSession || !this.decoderSession) {
      console.warn('SAM model not loaded');
      return null;
    }

    try {
      // Step 1: Encode image (only if image changed)
      if (!this.imageEmbedding || !this.isSameImage(imageData)) {
        console.log('Encoding image...');
        const preprocessed = this.preprocessImage(imageData);
        const encoderFeeds = { 'image': preprocessed };
        const encoderResults = await this.encoderSession.run(encoderFeeds);
        this.imageEmbedding = encoderResults.image_embeddings;
        this.lastImageData = imageData;
        console.log('Image encoded');
      }
      
      // Step 2: Prepare prompt (points)
      const { pointCoords, pointLabels } = this.preparePrompt(promptPoints, imageData);
      
      // Step 3: Decode with prompts
      console.log('Decoding mask with', promptPoints.length, 'prompt points...');
      const decoderFeeds = {
        'image_embeddings': this.imageEmbedding,
        'point_coords': pointCoords,
        'point_labels': pointLabels
      };
      
      const decoderResults = await this.decoderSession.run(decoderFeeds);
      
      // Step 4: Extract and process mask
      const masks = decoderResults.masks;
      return this.processSAMMask(masks, imageData.width, imageData.height);
    } catch (error) {
      console.error('SAM inference failed:', error);
      return null;
    }
  }

  private isSameImage(imageData: ImageData): boolean {
    if (!this.lastImageData) return false;
    return this.lastImageData.width === imageData.width &&
           this.lastImageData.height === imageData.height;
  }

  private preprocessImage(imageData: ImageData): ort.Tensor {
    // SAM expects [1, 3, 1024, 1024] input
    const size = SAM_MODEL_CONFIG.imageSize;
    
    // Resize image to 1024x1024
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    
    // Create temporary canvas with original image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = imageData.width;
    tempCanvas.height = imageData.height;
    const tempCtx = tempCanvas.getContext('2d')!;
    tempCtx.putImageData(imageData, 0, 0);
    
    // Draw resized
    ctx.drawImage(tempCanvas, 0, 0, size, size);
    const resizedData = ctx.getImageData(0, 0, size, size);
    
    // Convert to tensor [1, 3, H, W] with normalization
    // SAM normalization: mean=[123.675, 116.28, 103.53], std=[58.395, 57.12, 57.375]
    const tensorData = new Float32Array(3 * size * size);
    const pixelMeans = [123.675, 116.28, 103.53];
    const pixelStds = [58.395, 57.12, 57.375];
    
    for (let i = 0; i < size * size; i++) {
      const r = resizedData.data[i * 4];
      const g = resizedData.data[i * 4 + 1];
      const b = resizedData.data[i * 4 + 2];
      
      // Normalize and store in CHW format
      tensorData[i] = (r - pixelMeans[0]) / pixelStds[0];
      tensorData[size * size + i] = (g - pixelMeans[1]) / pixelStds[1];
      tensorData[size * size * 2 + i] = (b - pixelMeans[2]) / pixelStds[2];
    }
    
    return new ort.Tensor('float32', tensorData, [1, 3, size, size]);
  }

  private preparePrompt(
    points: Point[],
    imageData: ImageData
  ): { pointCoords: ort.Tensor; pointLabels: ort.Tensor } {
    const size = SAM_MODEL_CONFIG.imageSize;
    const scaleX = size / imageData.width;
    const scaleY = size / imageData.height;
    
    // Scale points to 1024x1024 space
    const coords = new Float32Array(points.length * 2);
    const labels = new Float32Array(points.length);
    
    for (let i = 0; i < points.length; i++) {
      coords[i * 2] = points[i].x * scaleX;
      coords[i * 2 + 1] = points[i].y * scaleY;
      labels[i] = 1; // 1 = foreground point, 0 = background point
    }
    
    return {
      pointCoords: new ort.Tensor('float32', coords, [1, points.length, 2]),
      pointLabels: new ort.Tensor('float32', labels, [1, points.length])
    };
  }

  private processSAMMask(
    maskTensor: ort.Tensor,
    originalWidth: number,
    originalHeight: number
  ): Uint8ClampedArray {
    // SAM outputs masks at 256x256, need to resize back
    const maskData = maskTensor.data as Float32Array;
    const maskSize = 256; // SAM default output size
    
    // Create temporary canvas for mask
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = maskSize;
    maskCanvas.height = maskSize;
    const ctx = maskCanvas.getContext('2d')!;
    const imageData = ctx.createImageData(maskSize, maskSize);
    
    // Convert to binary mask
    for (let i = 0; i < maskSize * maskSize; i++) {
      const value = maskData[i] > 0 ? 255 : 0;
      imageData.data[i * 4] = value;
      imageData.data[i * 4 + 1] = value;
      imageData.data[i * 4 + 2] = value;
      imageData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    
    // Resize to original dimensions
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = originalWidth;
    outputCanvas.height = originalHeight;
    const outputCtx = outputCanvas.getContext('2d')!;
    outputCtx.drawImage(maskCanvas, 0, 0, originalWidth, originalHeight);
    
    const outputData = outputCtx.getImageData(0, 0, originalWidth, originalHeight);
    const result = new Uint8ClampedArray(originalWidth * originalHeight);
    
    for (let i = 0; i < originalWidth * originalHeight; i++) {
      result[i] = outputData.data[i * 4];
    }
    
    return result;
  }

  async segmentWithAutoPoints(
    imageData: ImageData
  ): Promise<InstanceMask[]> {
    // Generate a grid of points to sample the image
    const gridSize = 16;
    const stepX = Math.floor(imageData.width / gridSize);
    const stepY = Math.floor(imageData.height / gridSize);
    const instances: InstanceMask[] = [];
    
    console.log(`Sampling image with ${gridSize}x${gridSize} grid...`);
    
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const pointX = Math.min(x * stepX + stepX / 2, imageData.width - 1);
        const pointY = Math.min(y * stepY + stepY / 2, imageData.height - 1);
        
        // Check if this point is in a bright region (potential root)
        const pixelIdx = (Math.floor(pointY) * imageData.width + Math.floor(pointX)) * 4;
        const brightness = (imageData.data[pixelIdx] + imageData.data[pixelIdx + 1] + imageData.data[pixelIdx + 2]) / 3;
        
        if (brightness < 150) continue; // Skip dark regions
        
        try {
          const mask = await this.runInference(imageData, [{ x: pointX, y: pointY }]);
          if (mask) {
            // Convert mask to instance
            const instance = this.maskToInstance(mask, imageData.width, imageData.height, instances.length);
            if (instance && instance.area > 200) {
              instances.push(instance);
            }
          }
        } catch (error) {
          console.error('Error processing point:', error);
        }
      }
    }
    
    // Remove duplicate/overlapping instances
    return this.removeDuplicates(instances);
  }

  private maskToInstance(
    mask: Uint8ClampedArray,
    width: number,
    height: number,
    id: number
  ): InstanceMask | null {
    const pixels: Point[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (mask[idx] === 255) {
          pixels.push({ x, y });
        }
      }
    }
    
    if (pixels.length === 0) return null;
    
    const bbox = calculateBoundingBox(pixels);
    const centroid = calculateCentroid(pixels);
    
    return {
      id: `sam_instance_${id}`,
      mask,
      width,
      height,
      bbox,
      area: pixels.length,
      centroid,
      confidence: 0.95
    };
  }

  private removeDuplicates(instances: InstanceMask[]): InstanceMask[] {
    const result: InstanceMask[] = [];
    
    for (const instance of instances) {
      let isDuplicate = false;
      
      for (const existing of result) {
        // Calculate overlap
        const overlap = this.calculateOverlap(instance.mask, existing.mask);
        if (overlap > 0.7) {
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        result.push(instance);
      }
    }
    
    return result;
  }

  private calculateOverlap(mask1: Uint8ClampedArray, mask2: Uint8ClampedArray): number {
    let intersection = 0;
    let union = 0;
    
    for (let i = 0; i < mask1.length; i++) {
      if (mask1[i] === 255 || mask2[i] === 255) union++;
      if (mask1[i] === 255 && mask2[i] === 255) intersection++;
    }
    
    return union > 0 ? intersection / union : 0;
  }
}

const samModel = new SAMModelManager();

/**
 * Perform instance segmentation using traditional computer vision as fallback
 * This will be used if SAM model is not available
 * Optimized for detecting white, elongated root structures
 */
async function fallbackInstanceSegmentation(
  imageData: ImageData,
  config: SegmentationConfig = DEFAULT_CONFIG
): Promise<SegmentationResult> {
  const startTime = performance.now();
  
  console.log('Starting segmentation optimized for white elongated roots...');
  console.log('Config:', config);
  
  // Step 1: Enhance white/bright regions (roots)
  const enhanced = enhanceWhiteStructures(imageData, config);
  
  // Step 2: Convert to grayscale
  const grayscale = convertToGrayscale(enhanced);
  
  // Step 3: Apply thresholding to isolate bright structures
  const binary = thresholdForWhiteStructures(grayscale);
  
  // Step 4: Apply morphological operations optimized for elongated structures
  const morphed = morphologicalOperationsForElongated(binary);
  
  // Step 5: Find connected components (instances)
  const instances = findConnectedComponents(morphed, config);
  
  // Step 6: Filter instances by elongation and other shape properties
  const filteredInstances = filterElongatedInstances(instances, config);
  
  console.log(`Segmentation complete: Found ${filteredInstances.length} elongated root instances`);
  
  const processingTime = performance.now() - startTime;
  
  return {
    instances: filteredInstances,
    totalInstances: filteredInstances.length,
    processingTime
  };
}

/**
 * Enhance white/bright structures in the image (where roots typically appear)
 * This amplifies bright regions while suppressing darker background
 */
function enhanceWhiteStructures(imageData: ImageData, config: SegmentationConfig): ImageData {
  const enhanced = new ImageData(imageData.width, imageData.height);
  const { data } = imageData;
  
  // First pass: find brightness statistics
  let minBrightness = 255;
  let maxBrightness = 0;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const brightness = (r + g + b) / 3;
    
    minBrightness = Math.min(minBrightness, brightness);
    maxBrightness = Math.max(maxBrightness, brightness);
  }
  
  // Calculate threshold for "bright" regions using config
  const brightnessRange = maxBrightness - minBrightness;
  const brightThreshold = minBrightness + (brightnessRange * config.brightnessPercentile);
  
  console.log(`Brightness range: ${minBrightness.toFixed(1)} - ${maxBrightness.toFixed(1)}, threshold: ${brightThreshold.toFixed(1)}`);
  
  // Second pass: enhance bright regions
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const brightness = (r + g + b) / 3;
    
    let enhancedValue;
    if (brightness > brightThreshold) {
      // Amplify bright regions
      const normalizedBrightness = (brightness - brightThreshold) / (maxBrightness - brightThreshold);
      enhancedValue = Math.min(255, 128 + normalizedBrightness * 127);
    } else {
      // Suppress darker regions
      const normalizedBrightness = (brightness - minBrightness) / (brightThreshold - minBrightness);
      enhancedValue = normalizedBrightness * 128;
    }
    
    enhanced.data[i] = enhancedValue;
    enhanced.data[i + 1] = enhancedValue;
    enhanced.data[i + 2] = enhancedValue;
    enhanced.data[i + 3] = 255;
  }
  
  return enhanced;
}

/**
 * Convert image to grayscale
 */
function convertToGrayscale(imageData: ImageData): ImageData {
  const grayscale = new ImageData(imageData.width, imageData.height);
  const { data } = imageData;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    
    grayscale.data[i] = gray;
    grayscale.data[i + 1] = gray;
    grayscale.data[i + 2] = gray;
    grayscale.data[i + 3] = 255;
  }
  
  return grayscale;
}

/**
 * Apply thresholding optimized for white/bright structures
 * Uses Otsu's method for automatic threshold selection
 */
function thresholdForWhiteStructures(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  
  // Calculate histogram
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    histogram[data[i]]++;
  }
  
  // Apply Otsu's method to find optimal threshold
  const total = width * height;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += i * histogram[i];
  }
  
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVariance = 0;
  let threshold = 0;
  
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    
    wF = total - wB;
    if (wF === 0) break;
    
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  
  // Bias towards higher threshold to focus on brighter structures
  threshold = Math.max(threshold, 128);
  console.log(`Otsu threshold: ${threshold}`);
  
  // Apply threshold
  const result = new ImageData(width, height);
  for (let i = 0; i < data.length; i += 4) {
    const value = data[i] > threshold ? 255 : 0;
    result.data[i] = value;
    result.data[i + 1] = value;
    result.data[i + 2] = value;
    result.data[i + 3] = 255;
  }
  
  return result;
}

/**
 * Apply adaptive thresholding to segment foreground from background
 * Note: Currently unused, kept for reference
 */
// @ts-expect-error - unused function kept for reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function adaptiveThreshold(imageData: ImageData): ImageData {
  const result = new ImageData(imageData.width, imageData.height);
  const { width, height, data } = imageData;
  const windowSize = 15;
  const c = 10; // Constant to subtract from mean
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Calculate local mean
      let sum = 0;
      let count = 0;
      
      for (let dy = -windowSize; dy <= windowSize; dy++) {
        for (let dx = -windowSize; dx <= windowSize; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            sum += data[idx];
            count++;
          }
        }
      }
      
      const mean = sum / count;
      const idx = (y * width + x) * 4;
      const value = data[idx] > (mean - c) ? 255 : 0;
      
      result.data[idx] = value;
      result.data[idx + 1] = value;
      result.data[idx + 2] = value;
      result.data[idx + 3] = 255;
    }
  }
  
  return result;
}

/**
 * Apply morphological operations optimized for elongated structures
 * Uses anisotropic operations to preserve elongated shapes
 */
function morphologicalOperationsForElongated(imageData: ImageData): ImageData {
  // First, use opening to remove small noise (erode then dilate)
  const eroded = erode(imageData, 2);
  const opened = dilate(eroded, 2);
  
  // Then, use closing to fill small gaps (dilate then erode)
  const dilated = dilate(opened, 4);
  const closed = erode(dilated, 4);
  
  return closed;
}

/**
 * Apply morphological operations (closing) to clean up the binary image
 * Note: Currently unused, kept for reference
 */
// @ts-expect-error - unused function kept for reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function morphologicalOperations(imageData: ImageData): ImageData {
  // Dilate then erode (closing operation)
  const dilated = dilate(imageData, 3);
  const closed = erode(dilated, 3);
  return closed;
}

/**
 * Morphological dilation
 */
function dilate(imageData: ImageData, radius: number): ImageData {
  const result = new ImageData(imageData.width, imageData.height);
  const { width, height, data } = imageData;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxVal = 0;
      
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            if (data[idx] > maxVal) {
              maxVal = data[idx];
            }
          }
        }
      }
      
      const idx = (y * width + x) * 4;
      result.data[idx] = maxVal;
      result.data[idx + 1] = maxVal;
      result.data[idx + 2] = maxVal;
      result.data[idx + 3] = 255;
    }
  }
  
  return result;
}

/**
 * Morphological erosion
 */
function erode(imageData: ImageData, radius: number): ImageData {
  const result = new ImageData(imageData.width, imageData.height);
  const { width, height, data } = imageData;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let minVal = 255;
      
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            if (data[idx] < minVal) {
              minVal = data[idx];
            }
          }
        }
      }
      
      const idx = (y * width + x) * 4;
      result.data[idx] = minVal;
      result.data[idx + 1] = minVal;
      result.data[idx + 2] = minVal;
      result.data[idx + 3] = 255;
    }
  }
  
  return result;
}

/**
 * Find connected components using flood fill algorithm
 */
function findConnectedComponents(imageData: ImageData, config: SegmentationConfig): InstanceMask[] {
  const { width, height, data } = imageData;
  const visited = new Uint8Array(width * height);
  const instances: InstanceMask[] = [];
  let instanceId = 0;
  
  const minAreaThreshold = config.minArea; // Use config value
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const pixelIdx = idx * 4;
      
      if (data[pixelIdx] === 255 && visited[idx] === 0) {
        // Found a new instance, perform flood fill
        const instanceMask = new Uint8ClampedArray(width * height);
        const pixels: Point[] = [];
        const stack: Point[] = [{ x, y }];
        
        while (stack.length > 0) {
          const point = stack.pop()!;
          const pIdx = point.y * width + point.x;
          
          if (
            point.x < 0 || point.x >= width ||
            point.y < 0 || point.y >= height ||
            visited[pIdx] === 1 ||
            data[pIdx * 4] !== 255
          ) {
            continue;
          }
          
          visited[pIdx] = 1;
          instanceMask[pIdx] = 255;
          pixels.push(point);
          
          // Add neighbors
          stack.push({ x: point.x + 1, y: point.y });
          stack.push({ x: point.x - 1, y: point.y });
          stack.push({ x: point.x, y: point.y + 1 });
          stack.push({ x: point.x, y: point.y - 1 });
        }
        
        // Check if instance meets minimum size
        if (pixels.length >= minAreaThreshold) {
          const bbox = calculateBoundingBox(pixels);
          const centroid = calculateCentroid(pixels);
          
          instances.push({
            id: `instance_${instanceId++}`,
            mask: instanceMask,
            width,
            height,
            bbox,
            area: pixels.length,
            centroid,
            confidence: 1.0 // For traditional CV, we don't have confidence scores
          });
        }
      }
    }
  }
  
  return instances;
}

/**
 * Filter instances to keep only elongated structures (likely to be roots)
 */
function filterElongatedInstances(instances: InstanceMask[], config: SegmentationConfig): InstanceMask[] {
  console.log(`Filtering ${instances.length} instances with config:`, {
    minAspectRatio: config.minAspectRatio,
    minArea: config.minArea,
    maxSolidity: config.maxSolidity,
    minCircularityInverse: config.minCircularityInverse
  });
  
  return instances.filter((instance, idx) => {
    const { bbox, area } = instance;
    
    // Calculate aspect ratio (elongation)
    const width = bbox.width;
    const height = bbox.height;
    const aspectRatio = Math.max(width, height) / Math.min(width, height);
    
    // Calculate solidity (area / bounding box area)
    const bboxArea = width * height;
    const solidity = area / bboxArea;
    
    // Calculate extent (perimeter-based elongation)
    const perimeter = 2 * (width + height);
    const circularityInverse = (perimeter * perimeter) / (4 * Math.PI * area);
    
    // Filters for root-like structures using config:
    const isElongated = aspectRatio > config.minAspectRatio;
    const hasMinimumSize = area > config.minArea;
    const isIrregular = solidity < config.maxSolidity;
    const isNotCircular = circularityInverse > config.minCircularityInverse;
    
    const passes = isElongated && hasMinimumSize && isIrregular && isNotCircular;
    
    console.log(`Instance ${idx}: AR=${aspectRatio.toFixed(2)}, Area=${area}, Sol=${solidity.toFixed(2)}, Circ=${circularityInverse.toFixed(2)} => ${passes ? 'PASS' : 'FAIL'}`);
    
    return passes;
  });
}

/**
 * Calculate bounding box for a set of points
 */
function calculateBoundingBox(points: Point[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

/**
 * Calculate centroid of a set of points
 */
function calculateCentroid(points: Point[]): Point {
  let sumX = 0;
  let sumY = 0;
  
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  
  return {
    x: sumX / points.length,
    y: sumY / points.length
  };
}

/**
 * Main function to perform instance segmentation on an image
 * @param imageData - The image to segment
 * @param useSAM - Whether to try loading SAM model (falls back to CV if unavailable)
 * @param config - Configuration for root detection parameters
 */
export async function performInstanceSegmentation(
  imageData: ImageData,
  useSAM: boolean = true,
  config: SegmentationConfig = DEFAULT_CONFIG
): Promise<SegmentationResult> {
  const startTime = performance.now();
  
  // Try to load and use SAM model if requested
  if (useSAM) {
    const modelLoaded = await samModel.loadModel();
    if (modelLoaded) {
      console.log('✓ Using SAM model for segmentation');
      try {
        const instances = await samModel.segmentWithAutoPoints(imageData);
        const processingTime = performance.now() - startTime;
        
        console.log(`SAM segmentation complete: ${instances.length} instances in ${processingTime.toFixed(2)}ms`);
        
        return {
          instances,
          totalInstances: instances.length,
          processingTime
        };
      } catch (error) {
        console.error('SAM segmentation failed:', error);
        console.warn('Falling back to computer vision method');
      }
    } else {
      console.warn('SAM model not available, using fallback method');
    }
  }
  
  // Use traditional computer vision method as fallback
  return fallbackInstanceSegmentation(imageData, config);
}

/**
 * Extract skeleton/centerline from instance mask for measurement
 * This helps create a line measurement along the root's length
 */
export function extractInstanceSkeleton(mask: InstanceMask): Point[] {
  const { width, height } = mask;
  const maskData = mask.mask;
  
  // Apply thinning algorithm to get skeleton
  const skeleton = zhangSuenThinning(maskData, width, height);
  
  // Extract points from skeleton
  const points: Point[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (skeleton[idx] === 255) {
        points.push({ x, y });
      }
    }
  }
  
  // Order points to form a continuous path (simplified - take endpoints)
  if (points.length > 0) {
    const endpoints = findSkeletonEndpoints(points, width, height, skeleton);
    if (endpoints.length >= 2) {
      // Return path from one endpoint to another through skeleton
      return findPathThroughSkeleton(endpoints[0], endpoints[1], skeleton, width, height);
    }
  }
  
  return points;
}

/**
 * Zhang-Suen thinning algorithm for skeletonization
 */
function zhangSuenThinning(
  maskData: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(maskData);
  let hasChanged = true;
  
  // Simplified thinning - for production, use full Zhang-Suen algorithm
  // This is a basic implementation
  const maxIterations = 50;
  let iteration = 0;
  
  while (hasChanged && iteration < maxIterations) {
    hasChanged = false;
    iteration++;
    
    const toRemove: number[] = [];
    
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        
        if (result[idx] === 255) {
          // Check 8-neighbors
          const neighbors = [
            result[(y - 1) * width + x],     // N
            result[(y - 1) * width + x + 1], // NE
            result[y * width + x + 1],       // E
            result[(y + 1) * width + x + 1], // SE
            result[(y + 1) * width + x],     // S
            result[(y + 1) * width + x - 1], // SW
            result[y * width + x - 1],       // W
            result[(y - 1) * width + x - 1]  // NW
          ];
          
          const blackNeighbors = neighbors.filter(n => n === 255).length;
          
          // Remove if it has 2-6 neighbors and doesn't disconnect the skeleton
          if (blackNeighbors >= 2 && blackNeighbors <= 6) {
            toRemove.push(idx);
            hasChanged = true;
          }
        }
      }
    }
    
    // Remove marked pixels
    for (const idx of toRemove) {
      result[idx] = 0;
    }
  }
  
  return result;
}

/**
 * Find endpoints of skeleton (points with only 1 neighbor)
 */
function findSkeletonEndpoints(
  points: Point[],
  width: number,
  height: number,
  skeleton: Uint8ClampedArray
): Point[] {
  const endpoints: Point[] = [];
  
  for (const point of points) {
    const { x, y } = point;
    let neighborCount = 0;
    
    // Count 8-connected neighbors
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        
        const nx = x + dx;
        const ny = y + dy;
        
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const idx = ny * width + nx;
          if (skeleton[idx] === 255) {
            neighborCount++;
          }
        }
      }
    }
    
    // Endpoint has only 1 neighbor
    if (neighborCount === 1) {
      endpoints.push(point);
    }
  }
  
  return endpoints;
}

/**
 * Find path through skeleton using A* algorithm
 */
function findPathThroughSkeleton(
  start: Point,
  end: Point,
  _skeleton: Uint8ClampedArray,
  _width: number,
  _height: number
): Point[] {
  // Simplified path finding - for production, implement full A*
  // Return start and end for now
  return [start, end];
}

/**
 * Calculate the length of a root instance based on its skeleton
 */
export function calculateInstanceLength(mask: InstanceMask): number {
  const skeleton = extractInstanceSkeleton(mask);
  
  // Calculate total path length
  let length = 0;
  for (let i = 1; i < skeleton.length; i++) {
    const dx = skeleton[i].x - skeleton[i - 1].x;
    const dy = skeleton[i].y - skeleton[i - 1].y;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  
  return length;
}

/**
 * Generate a color for visualizing an instance
 */
export function generateInstanceColor(instanceId: number): string {
  const hue = (instanceId * 137.508) % 360; // Golden angle for good distribution
  return `hsl(${hue}, 70%, 50%)`;
}
