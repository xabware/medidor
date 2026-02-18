/** Downscale an image to fit within `maxDim` pixels, preserving aspect ratio. */

export interface CompressedImage {
  dataUrl: string;
  width: number;
  height: number;
}

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
