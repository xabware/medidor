# SAM3 Instance Segmentation Implementation

## Overview

This implementation adds SAM (Segment Anything Model) inspired instance segmentation capabilities to the Medidor application, enabling automatic detection and measurement of individual root instances.

## Features Implemented

### 1. Instance Segmentation Engine (`src/utils/sam3Segmentation.ts`)

- **Fallback Computer Vision Method**: Uses traditional image processing techniques (adaptive thresholding, morphological operations, connected component analysis) as a robust fallback when SAM models are not available
- **ONNX Runtime Integration**: Infrastructure ready for loading and running SAM models via ONNX Runtime Web
- **Instance Detection**: Automatically finds and segments individual roots in images
- **Skeleton Extraction**: Generates centerline paths through each root for accurate length measurements
- **Instance Masking**: Creates binary masks for each detected root instance

### 2. Type System Extensions (`src/types/index.ts`)

Added new interfaces:
- `InstanceSegment`: Stores segmentation mask data, bounding boxes, centroids, and metadata
- Extended `DrawingLine` with 'instance' type for measurements derived from segmentation
- Extended `LoadedImage` to store instance segments

### 3. Context Management (`src/context/MedidorContext.tsx`)

New methods:
- `addInstances()`: Store segmented instances for an image
- `removeInstance()`: Delete a specific instance
- `clearInstances()`: Remove all instances from an image
- `updateInstanceMeasurement()`: Associate measurements with instances

### 4. Visual Editor Integration (`src/components/ImageEditor.tsx`)

UI Features:
- **"Segmentar raíces" Button**: Triggers instance segmentation
- **Instance Overlay Panel**: Shows segmentation results with statistics
- **Visual Feedback**: 
  - Colored masks overlaid on detected roots
  - Bounding boxes around each instance
  - Instance labels with unique colors
- **Measurement Creation**: Automatically generates measurements for each detected root

## How to Use

### Basic Workflow

1. **Load an Image**: Import an image containing roots

2. **Optional - Calibrate**: Set up calibration if you need real-world measurements

3. **Optional - Crop**: Focus on a specific region of interest

4. **Segment Roots**: Click the "🎯 Segmentar raíces" button in the toolbar

5. **Review Results**: 
   - View the overlay panel showing the number of detected instances
   - Inspect colored masks and bounding boxes on the canvas
   - Check the list of detected roots with their areas and confidence scores

6. **Create Measurements**: Click "✓ Crear mediciones" to automatically generate measurements for each root based on skeleton extraction

7. **Export Data**: Use the measurements panel to export all measurements to CSV

### Advanced Usage

#### Adjusting Detection Parameters

The segmentation algorithm uses several parameters that can be tuned in `sam3Segmentation.ts`:

```typescript
const minAreaThreshold = 100; // Minimum pixels for a valid instance (line 398)
const windowSize = 15; // Adaptive threshold window (line 167)
const c = 10; // Threshold constant (line 168)
```

#### Instance Filtering

You can filter instances by area, confidence, or other criteria before creating measurements:

```typescript
// In ImageEditor.tsx, modify handleCreateMeasurementsFromInstances
const filteredInstances = currentImage.instances.filter(inst => 
  inst.area > 500 && // Minimum area
  inst.confidence > 0.8 // Minimum confidence
);
```

## Technical Details

### Segmentation Algorithm

The current implementation uses a multi-stage computer vision pipeline:

1. **Grayscale Conversion**: Converts RGB to luminance-based grayscale
2. **Adaptive Thresholding**: Segments foreground (roots) from background
3. **Morphological Operations**: Cleans up the binary mask using dilation and erosion
4. **Connected Component Analysis**: Identifies separate root instances using flood fill
5. **Skeleton Extraction**: Uses thinning algorithms to find centerlines
6. **Measurement Generation**: Calculates path length through the skeleton

### Future Enhancements

To integrate a full SAM model:

1. Download a quantized SAM ONNX model (e.g., from Hugging Face)
2. Place it in `public/models/`
3. Update the `loadModel()` method in `SAMModelManager` to load the actual model
4. Implement proper input preprocessing (resize to 1024x1024, normalize, etc.)
5. Parse the model's output masks and merge with the current workflow

### Performance Considerations

- **Processing Time**: Typically 50-500ms depending on image size and complexity
- **Memory Usage**: Proportional to image dimensions (stores full masks)
- **Browser Compatibility**: Requires modern browsers with Canvas API support

## Dependencies

- `onnxruntime-web`: ^1.14.0 - ONNX Runtime for browser-based model inference
- React context and hooks for state management
- HTML Canvas API for image processing and visualization

## Limitations

- Current implementation uses fallback CV methods (SAM model integration is infrastructure-ready but not active)
- Skeleton extraction is simplified (production version would use full Zhang-Suen thinning)
- No GPU acceleration (would require WebGL/WebGPU backend for ONNX Runtime)
- Limited to 2D root analysis

## Troubleshooting

### No Instances Detected
- Ensure the image has sufficient contrast between roots and background
- Try cropping to focus on the region of interest
- Adjust threshold parameters in the code

### Too Many False Positives
- Increase `minAreaThreshold` to filter small noise
- Apply morphological operations with larger radius
- Pre-process images to reduce background texture

### Performance Issues
- Reduce image size before segmentation
- Crop to smaller regions of interest
- Process images in batches rather than real-time

## API Reference

### Main Functions

```typescript
// Perform instance segmentation on image data
performInstanceSegmentation(
  imageData: ImageData,
  useSAM: boolean = false
): Promise<SegmentationResult>

// Extract skeleton centerline from instance mask
extractInstanceSkeleton(
  mask: InstanceMask
): Point[]

// Calculate length along skeleton path
calculateInstanceLength(
  mask: InstanceMask
): number

// Generate unique color for instance visualization
generateInstanceColor(
  instanceId: number
): string
```

## Contributing

To extend or improve the segmentation:

1. Add new preprocessing filters in `sam3Segmentation.ts`
2. Implement alternative skeletonization algorithms
3. Integrate actual SAM model inference
4. Add post-processing filters (e.g., merge overlapping instances)
5. Implement user-interactive refinement tools (add/remove points)

## License

Same as parent project (Medidor)
