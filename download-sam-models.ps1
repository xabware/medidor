# SAM Model Downloader Script for Windows PowerShell
# This script downloads the quantized SAM models from Hugging Face

Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  SAM Model Downloader" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""

$modelsDir = Join-Path $PSScriptRoot "public\models"

# Create models directory if it doesn't exist
if (-not (Test-Path $modelsDir)) {
    Write-Host "Creating models directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
}

Set-Location $modelsDir
Write-Host "Models directory: $modelsDir" -ForegroundColor Green
Write-Host ""

# Model URLs - Using direct GitHub releases or public CDN
# Alternative 1: From a public GitHub repository
$encoderUrl = "https://github.com/vietanhdev/samexporter/releases/download/v0.1.0/sam_vit_b_encoder.onnx"
$decoderUrl = "https://github.com/vietanhdev/samexporter/releases/download/v0.1.0/sam_vit_b_decoder.onnx"

# Alternative 2: If above fails, use quantized versions from different source
$encoderUrlAlt = "https://huggingface.co/facebook/sam-vit-base/resolve/main/onnx/encoder_quantized.onnx"
$decoderUrlAlt = "https://huggingface.co/facebook/sam-vit-base/resolve/main/onnx/decoder_quantized.onnx"

$encoderFile = "sam_vit_b_encoder_quantized.onnx"
$decoderFile = "sam_vit_b_decoder_quantized.onnx"

# Download encoder
if (Test-Path $encoderFile) {
    Write-Host "Encoder already exists, skipping..." -ForegroundColor Green
}
else {
    Write-Host "Downloading encoder (~90 MB)..." -ForegroundColor Yellow
    Write-Host "Trying primary source..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $encoderUrl -OutFile $encoderFile -UseBasicParsing -TimeoutSec 300
        Write-Host "Encoder downloaded successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "Primary source failed, trying alternative..." -ForegroundColor Yellow
        try {
            Invoke-WebRequest -Uri $encoderUrlAlt -OutFile $encoderFile -UseBasicParsing -TimeoutSec 300
            Write-Host "Encoder downloaded successfully from alternative source!" -ForegroundColor Green
        }
        catch {
            Write-Host "Failed to download encoder from all sources: $_" -ForegroundColor Red
            Write-Host "Please download manually from:" -ForegroundColor Yellow
            Write-Host "  $encoderUrl" -ForegroundColor White
            Write-Host "or visit: https://github.com/facebookresearch/segment-anything/tree/main/scripts#onnx-export" -ForegroundColor White
            exit 1
        }
    }
}

# Download decoder
if (Test-Path $decoderFile) {
    Write-Host "Decoder already exists, skipping..." -ForegroundColor Green
}
else {
    Write-Host "Downloading decoder (~15 MB)..." -ForegroundColor Yellow
    Write-Host "Trying primary source..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $decoderUrl -OutFile $decoderFile -UseBasicParsing -TimeoutSec 300
        Write-Host "Decoder downloaded successfully!" -ForegroundColor Green
    }
    catch {
        Write-Host "Primary source failed, trying alternative..." -ForegroundColor Yellow
        try {
            Invoke-WebRequest -Uri $decoderUrlAlt -OutFile $decoderFile -UseBasicParsing -TimeoutSec 300
            Write-Host "Decoder downloaded successfully from alternative source!" -ForegroundColor Green
        }
        catch {
            Write-Host "Failed to download decoder from all sources: $_" -ForegroundColor Red
            Write-Host "Please download manually from:" -ForegroundColor Yellow
            Write-Host "  $decoderUrl" -ForegroundColor White
            Write-Host "or visit: https://github.com/facebookresearch/segment-anything/tree/main/scripts#onnx-export" -ForegroundColor White
            exit 1
        }
    }
}

Write-Host ""
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  Download Complete!" -ForegroundColor Green
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Files downloaded:" -ForegroundColor Yellow
Get-ChildItem $modelsDir | ForEach-Object {
    $sizeInMB = [math]::Round($_.Length / 1MB, 2)
    Write-Host "  - $($_.Name) ($sizeInMB MB)" -ForegroundColor White
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Run: npm run dev" -ForegroundColor White
Write-Host "  2. Open: http://localhost:5173" -ForegroundColor White
Write-Host "  3. Load an image and click '🎯 Segmentar raices'" -ForegroundColor White
Write-Host ""
