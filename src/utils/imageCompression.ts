/**
 * Image compression utility for reducing SAM processing time.
 * High-resolution phone camera images (e.g. 4000×3000) are downscaled to a
 * maximum dimension while preserving aspect ratio. SAM internally resizes to
 * 1024×1024 anyway, so pre-compressing loses no quality while significantly
 * speeding up image loading and processing.
 */

export interface CompressedImage {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Downscale an image so that its longest side is at most `maxDim` pixels.
 * Returns the original if it's already small enough.
 */
export async function compressImage(
  sourceUrl: string,
  maxDim: number = 1024,
): Promise<CompressedImage> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = sourceUrl;
  });

  let { width, height } = img;

  if (width <= maxDim && height <= maxDim) {
    return { dataUrl: sourceUrl, width, height };
  }

  const ratio = Math.min(maxDim / width, maxDim / height);
  width = Math.round(width * ratio);
  height = Math.round(height * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.85),
    width,
    height,
  };
}
