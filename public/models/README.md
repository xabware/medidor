# SAM Model Setup Instructions

## Download Quantized SAM Models

The application is configured to use quantized SAM models for browser-based inference. You need to download two model files.

### Option 1: Use the Download Script (Easiest)

Run the PowerShell script from the project root:

```powershell
.\download-sam-models.ps1
```

### Option 2: Manual Download from GitHub (Most Reliable)

**Step 1:** Visit https://github.com/vietanhdev/samexporter/releases

**Step 2:** Download these files from the latest release:
- `sam_vit_b_encoder.onnx` (~90 MB)
- `sam_vit_b_decoder.onnx` (~15 MB)

**Step 3:** Rename them:
- Rename `sam_vit_b_encoder.onnx` → `sam_vit_b_encoder_quantized.onnx`
- Rename `sam_vit_b_decoder.onnx` → `sam_vit_b_decoder_quantized.onnx`

**Step 4:** Place both files in `public/models/`

### Option 3: Export Your Own Models

If you want the most control, export SAM models yourself:

1. Install SAM:
   ```bash
   pip install git+https://github.com/facebookresearch/segment-anything.git
   ```

2. Download checkpoint:
   ```bash
   wget https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth
   ```

3. Use SAMExporter:
   ```bash
   git clone https://github.com/vietanhdev/samexporter.git
   cd samexporter
   python export.py --checkpoint sam_vit_b_01ec64.pth --output ../medidor/public/models --quantize
   ```

### Option 4: Direct URLs (Manual Download)

If the script fails, manually download from these URLs:

**Browser Download:**
- Encoder: https://github.com/vietanhdev/samexporter/releases/download/v0.1.0/sam_vit_b_encoder.onnx
- Decoder: https://github.com/vietanhdev/samexporter/releases/download/v0.1.0/sam_vit_b_decoder.onnx

**PowerShell (from `public/models` directory):**
```powershell
cd public\models

# Download encoder
Invoke-WebRequest -Uri "https://github.com/vietanhdev/samexporter/releases/download/v0.1.0/sam_vit_b_encoder.onnx" -OutFile "sam_vit_b_encoder_quantized.onnx"

# Download decoder
Invoke-WebRequest -Uri "https://github.com/vietanhdev/samexporter/releases/download/v0.1.0/sam_vit_b_decoder.onnx" -OutFile "sam_vit_b_decoder_quantized.onnx"
```

## Verify Installation

After downloading, your directory structure should look like:

```
medidor/
├── public/
│   └── models/
│       ├── sam_vit_b_encoder_quantized.onnx  (≈90 MB)
│       └── sam_vit_b_decoder_quantized.onnx  (≈15 MB)
├── src/
└── ...
```

## Testing

1. Start the development server:
   ```bash
   npm run dev
   ```

2. Open your browser to `http://localhost:5173`

3. Load an image and click "🎯 Segmentar raíces"

4. Check the browser console:
   - If SAM loads successfully: "✓ SAM model loaded successfully!"
   - If SAM fails to load: "Falling back to computer vision method"

## Model Information

**SAM ViT-B (Base) Quantized:**
- Encoder: ~90 MB (quantized from ~375 MB)
- Decoder: ~15 MB
- Total: ~105 MB
- Performance: 3-10 seconds per inference in browser
- Quality: High accuracy for general segmentation

**How It Works:**
1. **Encoder** (one-time): Processes the full image once, creates embeddings
2. **Decoder** (multiple): Takes embeddings + prompt points, generates masks
3. **Auto-sampling**: Grid of points samples the image to find all root instances

## Troubleshooting

### Models not loading?
- Check file names match exactly (case-sensitive)
- Verify files are in `public/models/` not `src/models/`
- Check browser console for errors
- Try clearing browser cache

### Too slow?
- SAM is computationally intensive
- Consider using the CV fallback (automatic if SAM unavailable)
- Reduce image size before segmentation (use crop feature)

### Not detecting roots well?
- SAM is general-purpose, not optimized for roots
- The CV fallback may work better for your specific use case
- Adjust the segmentation config parameters

## Fallback Mode

If SAM models are not available or fail to load, the application automatically falls back to the optimized computer vision method. This fallback is:
- ✅ Much faster (50-500ms vs 3-10s)
- ✅ Specifically tuned for white elongated structures
- ✅ Works offline
- ✅ No download required

You can force CV mode by passing `useSAM: false` in the code.

## License Note

SAM models are released under Apache 2.0 license by Meta AI Research.
Please review the license terms before commercial use: https://github.com/facebookresearch/segment-anything/blob/main/LICENSE
