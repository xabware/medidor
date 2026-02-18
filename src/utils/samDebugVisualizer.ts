/**
 * SAM Debug Visualizer — opens a persistent popup window that shows
 * every SAM decode call: the ROI image, input points, all returned masks,
 * IoU scores, and which mask was selected.
 */

let debugWin: Window | null = null;
let callCounter = 0;

/** Ensure the debug window is open. Returns the window reference. */
function ensureWindow(): Window {
  if (!debugWin || debugWin.closed) {
    debugWin = window.open('', 'sam_debug', 'width=1200,height=800,scrollbars=yes,resizable=yes');
    if (!debugWin) throw new Error('No se pudo abrir la ventana de debug (¿bloqueador de popups?)');
    debugWin.document.title = 'SAM Debug Visualizer';
    debugWin.document.head.innerHTML = `<style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 12px; }
      h2 { color: #00d4aa; margin: 16px 0 8px; border-bottom: 1px solid #333; padding-bottom: 4px; font-size: 16px; }
      .call-block { background: #16213e; border: 1px solid #0f3460; border-radius: 8px; margin-bottom: 16px; padding: 12px; }
      .call-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
      .call-header .num { background: #00d4aa; color: #000; font-weight: bold; font-size: 13px; padding: 2px 8px; border-radius: 4px; }
      .call-header .info { font-size: 13px; color: #aaa; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; margin: 8px 0; }
      .card { background: #0f3460; border-radius: 6px; padding: 8px; text-align: center; flex-shrink: 0; }
      .card.selected { border: 2px solid #00d4aa; }
      .card canvas { display: block; margin: 0 auto; }
      .card .label { font-size: 12px; margin-top: 4px; }
      .card .score { font-size: 11px; color: #aaa; }
      .card .badge { display: inline-block; background: #00d4aa; color: #000; font-size: 10px; font-weight: bold; padding: 1px 6px; border-radius: 3px; margin-top: 2px; }
      .legend { font-size: 12px; color: #888; margin: 4px 0; }
      .legend span.fg { color: #00ff88; }
      .legend span.bg { color: #ff4444; }
      .clear-btn { position: fixed; top: 8px; right: 8px; background: #e94560; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; z-index: 10; }
      .clear-btn:hover { background: #ff6b6b; }
    </style>`;
    debugWin.document.body.innerHTML = `<button class="clear-btn" onclick="document.getElementById('content').innerHTML=''">Limpiar</button><div id="content"></div>`;
    callCounter = 0;
  }
  return debugWin;
}

export interface DebugVisData {
  /** ROI-relative foreground points */
  fgPoints: Array<{ x: number; y: number }>;
  /** ROI-relative background points */
  bgPoints: Array<{ x: number; y: number }>;
  /** Original (ROI) image width & height */
  roiWidth: number;
  roiHeight: number;
  /** All masks from SAM (boolean 2D arrays, in original image space) */
  allMasks: boolean[][][];
  /** Area of each mask in pixels */
  allAreas: number[];
  /** IoU scores for each mask */
  scores: number[];
  /** Index of the selected mask */
  selectedIdx: number;
  /** Mask dimensions (may differ from ROI due to post-processing) */
  maskH: number;
  maskW: number;
  /** The data-URL of the ROI image (if available) */
  roiImageUrl?: string;
}

/** Maximum display width for each card canvas */
const MAX_CARD_W = 300;

/**
 * Post one SAM decode call's data to the debug window.
 */
export function debugVisualizeSAM(data: DebugVisData): void {
  let win: Window;
  try { win = ensureWindow(); } catch { return; }
  const doc = win.document;
  const container = doc.getElementById('content');
  if (!container) return;

  callCounter++;
  const block = doc.createElement('div');
  block.className = 'call-block';

  const scaleDisplay = Math.min(1, MAX_CARD_W / data.roiWidth);
  const dispW = Math.round(data.roiWidth * scaleDisplay);
  const dispH = Math.round(data.roiHeight * scaleDisplay);

  // Header
  block.innerHTML = `
    <div class="call-header">
      <span class="num">#${callCounter}</span>
      <span class="info">FG: ${data.fgPoints.length} pts | BG: ${data.bgPoints.length} pts | Mask: ${data.maskW}×${data.maskH}</span>
    </div>
    <p class="legend">Puntos: <span class="fg">● foreground</span> · <span class="bg">● background</span></p>
  `;

  const row = doc.createElement('div');
  row.className = 'row';

  // Helper: draw points on a canvas
  const drawPoints = (ctx: CanvasRenderingContext2D, sx: number, sy: number) => {
    for (const p of data.fgPoints) {
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#00ff88';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const p of data.bgPoints) {
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ff4444';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };

  // ─── Card 0: ROI image with points ───
  const imgCard = doc.createElement('div');
  imgCard.className = 'card';
  const imgCanvas = doc.createElement('canvas');
  imgCanvas.width = dispW;
  imgCanvas.height = dispH;
  const imgCtx = imgCanvas.getContext('2d')!;
  imgCtx.fillStyle = '#222';
  imgCtx.fillRect(0, 0, dispW, dispH);

  if (data.roiImageUrl) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = new (win as any).Image() as HTMLImageElement;
    img.onload = () => {
      imgCtx.drawImage(img, 0, 0, dispW, dispH);
      drawPoints(imgCtx, dispW / data.roiWidth, dispH / data.roiHeight);
    };
    img.src = data.roiImageUrl;
  } else {
    // No image available — just draw points on dark bg
    drawPoints(imgCtx, dispW / data.roiWidth, dispH / data.roiHeight);
  }

  imgCard.appendChild(imgCanvas);
  const imgLabel = doc.createElement('div');
  imgLabel.className = 'label';
  imgLabel.textContent = 'Imagen ROI + puntos';
  imgCard.appendChild(imgLabel);
  row.appendChild(imgCard);

  // ─── Cards 1-3: Each mask ───
  const maskScaleX = data.roiWidth / data.maskW;
  const maskScaleY = data.roiHeight / data.maskH;
  const pxTotal = data.maskH * data.maskW;

  for (let m = 0; m < data.allMasks.length; m++) {
    const mask = data.allMasks[m];
    const area = data.allAreas[m];
    const areaPct = (area / pxTotal * 100).toFixed(1);
    const score = data.scores[m]?.toFixed(3) ?? '?';
    const isSelected = m === data.selectedIdx;

    const card = doc.createElement('div');
    card.className = isSelected ? 'card selected' : 'card';

    const c = doc.createElement('canvas');
    c.width = dispW;
    c.height = dispH;
    const ctx = c.getContext('2d')!;

    // Draw mask — use ImageData for speed
    const id = ctx.createImageData(dispW, dispH);
    const px = id.data;
    // Color: selected = teal, others = orange
    const R = isSelected ? 0 : 230;
    const G = isSelected ? 212 : 150;
    const B = isSelected ? 170 : 30;

    for (let dy = 0; dy < dispH; dy++) {
      const my = Math.min(data.maskH - 1, Math.floor(dy / scaleDisplay / maskScaleY));
      for (let dx = 0; dx < dispW; dx++) {
        const mx = Math.min(data.maskW - 1, Math.floor(dx / scaleDisplay / maskScaleX));
        const idx = (dy * dispW + dx) * 4;
        if (mask[my]?.[mx]) {
          px[idx] = R; px[idx + 1] = G; px[idx + 2] = B; px[idx + 3] = 180;
        } else {
          px[idx] = 20; px[idx + 1] = 20; px[idx + 2] = 40; px[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(id, 0, 0);

    // Draw points on top
    drawPoints(ctx, dispW / data.roiWidth, dispH / data.roiHeight);

    card.appendChild(c);
    const lbl = doc.createElement('div');
    lbl.className = 'label';
    lbl.textContent = `Mask ${m} — ${areaPct}%`;
    card.appendChild(lbl);
    const sc = doc.createElement('div');
    sc.className = 'score';
    sc.textContent = `IoU: ${score}`;
    card.appendChild(sc);
    if (isSelected) {
      const bdg = doc.createElement('div');
      bdg.className = 'badge';
      bdg.textContent = 'ELEGIDA';
      card.appendChild(bdg);
    }
    row.appendChild(card);
  }

  block.appendChild(row);
  container.insertBefore(block, container.firstChild);  // newest on top

  // Auto-scroll to top
  win.scrollTo(0, 0);
}

/** Store the ROI image URL so samDecodePoints can include it in debug calls. */
let _roiImageUrl: string | null = null;

export function setDebugROIImageUrl(url: string | null): void {
  _roiImageUrl = url;
}

export function getDebugROIImageUrl(): string | null {
  return _roiImageUrl;
}

/** Enable/disable the debug visualizer. */
let _debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  _debugEnabled = enabled;
  if (!enabled && debugWin && !debugWin.closed) {
    debugWin.close();
    debugWin = null;
  }
}

export function isDebugEnabled(): boolean {
  return _debugEnabled;
}

/* ─── Component visualization ──────────────────────────────────────── */

export interface DebugComponentsData {
  roiWidth: number;
  roiHeight: number;
  maskH: number;
  maskW: number;
  components: Array<{
    mask: boolean[][];
    area: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
  }>;
  maskIdx: number;
  roiImageUrl?: string;
}

/** Distinct colors for up to 20 components */
const COMP_COLORS = [
  [0, 212, 170], [255, 99, 71], [50, 205, 50], [255, 215, 0],
  [138, 43, 226], [255, 127, 80], [0, 191, 255], [255, 20, 147],
  [0, 255, 127], [255, 165, 0], [106, 90, 205], [220, 20, 60],
  [64, 224, 208], [255, 105, 180], [124, 252, 0], [218, 112, 214],
  [240, 128, 128], [32, 178, 170], [255, 222, 173], [147, 112, 219],
];

/**
 * Show the connected components extracted from a SAM mask.
 * Each component is overlaid on the ROI image in a different color.
 */
export function debugVisualizeComponents(data: DebugComponentsData): void {
  let win: Window;
  try { win = ensureWindow(); } catch { return; }
  const doc = win.document;
  const container = doc.getElementById('content');
  if (!container) return;

  callCounter++;
  const block = doc.createElement('div');
  block.className = 'call-block';

  const scaleDisplay = Math.min(1, MAX_CARD_W * 2 / data.roiWidth); // wider card for overview
  const dispW = Math.round(data.roiWidth * scaleDisplay);
  const dispH = Math.round(data.roiHeight * scaleDisplay);

  // Header
  const header = doc.createElement('div');
  header.className = 'call-header';
  header.innerHTML = `
    <span class="num">#${callCounter} — COMPONENTES</span>
    <span class="info">${data.maskIdx < 0 ? 'Todas las máscaras' : `Mask ${data.maskIdx}`} → ${data.components.length} raíces detectadas</span>
  `;
  block.appendChild(header);

  const row = doc.createElement('div');
  row.className = 'row';

  const maskScaleX = data.roiWidth / data.maskW;
  const maskScaleY = data.roiHeight / data.maskH;

  // Card: all components overlaid on ROI image
  const overviewCard = doc.createElement('div');
  overviewCard.className = 'card selected';
  const overviewCanvas = doc.createElement('canvas');
  overviewCanvas.width = dispW;
  overviewCanvas.height = dispH;
  const ovCtx = overviewCanvas.getContext('2d')!;
  ovCtx.fillStyle = '#111';
  ovCtx.fillRect(0, 0, dispW, dispH);

  // Draw ROI image first, then overlay components
  const drawComponentsOverlay = () => {
    for (let ci = 0; ci < data.components.length; ci++) {
      const comp = data.components[ci];
      const [cr, cg, cb] = COMP_COLORS[ci % COMP_COLORS.length];
      const id = ovCtx.createImageData(dispW, dispH);
      const px = id.data;
      for (let dy = 0; dy < dispH; dy++) {
        const my = Math.min(data.maskH - 1, Math.floor(dy / scaleDisplay / maskScaleY));
        for (let dx = 0; dx < dispW; dx++) {
          const mx = Math.min(data.maskW - 1, Math.floor(dx / scaleDisplay / maskScaleX));
          if (comp.mask[my]?.[mx]) {
            const idx = (dy * dispW + dx) * 4;
            px[idx] = cr; px[idx + 1] = cg; px[idx + 2] = cb; px[idx + 3] = 140;
          }
        }
      }
      ovCtx.putImageData(id, 0, 0);
    }
    // Draw component numbers
    ovCtx.font = 'bold 14px sans-serif';
    ovCtx.textAlign = 'center';
    for (let ci = 0; ci < data.components.length; ci++) {
      const comp = data.components[ci];
      const cx = ((comp.bbox.minX + comp.bbox.maxX) / 2) * maskScaleX * scaleDisplay;
      const cy = ((comp.bbox.minY + comp.bbox.maxY) / 2) * maskScaleY * scaleDisplay;
      ovCtx.fillStyle = '#fff';
      ovCtx.strokeStyle = '#000';
      ovCtx.lineWidth = 3;
      ovCtx.strokeText(`${ci + 1}`, cx, cy);
      ovCtx.fillText(`${ci + 1}`, cx, cy);
    }
  };

  if (data.roiImageUrl) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = new (win as any).Image() as HTMLImageElement;
    img.onload = () => {
      ovCtx.drawImage(img, 0, 0, dispW, dispH);
      drawComponentsOverlay();
    };
    img.src = data.roiImageUrl;
  } else {
    drawComponentsOverlay();
  }

  overviewCard.appendChild(overviewCanvas);
  const ovLabel = doc.createElement('div');
  ovLabel.className = 'label';
  ovLabel.textContent = `${data.components.length} raíces (${data.maskIdx < 0 ? 'cluster cross-mask' : `mask ${data.maskIdx}`})`;
  overviewCard.appendChild(ovLabel);
  row.appendChild(overviewCard);

  // Individual component cards
  for (let ci = 0; ci < data.components.length; ci++) {
    const comp = data.components[ci];
    const [cr, cg, cb] = COMP_COLORS[ci % COMP_COLORS.length];
    const bw = comp.bbox.maxX - comp.bbox.minX + 1;
    const bh = comp.bbox.maxY - comp.bbox.minY + 1;
    const aspect = (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))).toFixed(1);

    const card = doc.createElement('div');
    card.className = 'card';
    const cardW = Math.max(60, Math.min(150, Math.round(bw * maskScaleX * scaleDisplay * 1.5)));
    const cardH = Math.max(60, Math.min(250, Math.round(bh * maskScaleY * scaleDisplay * 1.5)));
    const c = doc.createElement('canvas');
    c.width = cardW;
    c.height = cardH;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, cardW, cardH);

    // Render just the component bbox area
    const sxC = cardW / bw;
    const syC = cardH / bh;
    for (let my = comp.bbox.minY; my <= comp.bbox.maxY; my++) {
      for (let mx = comp.bbox.minX; mx <= comp.bbox.maxX; mx++) {
        if (comp.mask[my]?.[mx]) {
          const dx = Math.floor((mx - comp.bbox.minX) * sxC);
          const dy = Math.floor((my - comp.bbox.minY) * syC);
          const dw = Math.max(1, Math.ceil(sxC));
          const dh = Math.max(1, Math.ceil(syC));
          ctx.fillStyle = `rgba(${cr},${cg},${cb},0.8)`;
          ctx.fillRect(dx, dy, dw, dh);
        }
      }
    }

    card.appendChild(c);
    const lbl = doc.createElement('div');
    lbl.className = 'label';
    lbl.textContent = `#${ci + 1} — ${comp.area}px`;
    card.appendChild(lbl);
    const sc = doc.createElement('div');
    sc.className = 'score';
    sc.textContent = `${bw}×${bh} asp:${aspect}`;
    card.appendChild(sc);
    row.appendChild(card);
  }

  block.appendChild(row);
  container.insertBefore(block, container.firstChild);
  win.scrollTo(0, 0);
}

/* ─── Per-mask raw component visualization ────────────────────────── */

export interface DebugRawComponentsData {
  roiWidth: number;
  roiHeight: number;
  maskH: number;
  maskW: number;
  /** Raw components extracted from each mask (index = mask number) */
  rawPerMask: Array<Array<{
    mask: boolean[][];
    area: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
  }>>;
  /** Final filtered/clustered components (after erosion + dedup) */
  finalComponents: Array<{
    mask: boolean[][];
    area: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
  }>;
  roiImageUrl?: string;
}

/**
 * Show a comprehensive debug view of root extraction pipeline:
 * - Row per mask: raw extracted components overlaid on mask
 * - Final row: the clustered/deduped result
 */
export function debugVisualizeExtraction(data: DebugRawComponentsData): void {
  let win: Window;
  try { win = ensureWindow(); } catch { return; }
  const doc = win.document;
  const container = doc.getElementById('content');
  if (!container) return;

  callCounter++;
  const block = doc.createElement('div');
  block.className = 'call-block';

  const scaleDisplay = Math.min(1, MAX_CARD_W / data.roiWidth);
  const dispW = Math.round(data.roiWidth * scaleDisplay);
  const dispH = Math.round(data.roiHeight * scaleDisplay);

  const maskScaleX = data.roiWidth / data.maskW;
  const maskScaleY = data.roiHeight / data.maskH;

  // Header
  const header = doc.createElement('div');
  header.className = 'call-header';
  header.innerHTML = `
    <span class="num">#${callCounter} — PIPELINE</span>
    <span class="info">Extracción de componentes: ${data.rawPerMask.map((c, i) => `m${i}:${c.length}`).join(' ')} → final: ${data.finalComponents.length}</span>
  `;
  block.appendChild(header);

  /** Helper: render components onto a canvas with colored overlays */
  const renderComponents = (
    ctx: CanvasRenderingContext2D,
    comps: Array<{ mask: boolean[][]; area: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } }>,
    w: number,
    h: number,
    sd: number,
    sX: number,
    sY: number,
  ) => {
    for (let ci = 0; ci < comps.length; ci++) {
      const comp = comps[ci];
      const [cr, cg, cb] = COMP_COLORS[ci % COMP_COLORS.length];
      const id = ctx.createImageData(w, h);
      const px = id.data;
      for (let dy = 0; dy < h; dy++) {
        const my = Math.min(data.maskH - 1, Math.floor(dy / sd / sY));
        for (let dx = 0; dx < w; dx++) {
          const mx = Math.min(data.maskW - 1, Math.floor(dx / sd / sX));
          if (comp.mask[my]?.[mx]) {
            const idx = (dy * w + dx) * 4;
            px[idx] = cr; px[idx + 1] = cg; px[idx + 2] = cb; px[idx + 3] = 160;
          }
        }
      }
      ctx.putImageData(id, 0, 0);
    }
    // Labels
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    for (let ci = 0; ci < comps.length; ci++) {
      const comp = comps[ci];
      const cx = ((comp.bbox.minX + comp.bbox.maxX) / 2) * sX * sd;
      const cy = ((comp.bbox.minY + comp.bbox.maxY) / 2) * sY * sd;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.strokeText(`${ci + 1}`, cx, cy);
      ctx.fillText(`${ci + 1}`, cx, cy);
      // Area below
      ctx.font = '10px sans-serif';
      ctx.strokeText(`${comp.area}px`, cx, cy + 14);
      ctx.fillText(`${comp.area}px`, cx, cy + 14);
      ctx.font = 'bold 12px sans-serif';
    }
  };

  // ─── Row for each mask: show raw components ───
  for (let mi = 0; mi < data.rawPerMask.length; mi++) {
    const comps = data.rawPerMask[mi];

    const subtitle = doc.createElement('h2');
    subtitle.textContent = `Máscara ${mi}: ${comps.length} componente(s) bruto(s) — áreas: [${comps.slice(0, 8).map(c => c.area).join(', ')}${comps.length > 8 ? '…' : ''}]`;
    block.appendChild(subtitle);

    const row = doc.createElement('div');
    row.className = 'row';

    // Overview card for this mask
    const card = doc.createElement('div');
    card.className = 'card';
    const canvas = doc.createElement('canvas');
    canvas.width = dispW;
    canvas.height = dispH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, dispW, dispH);

    if (data.roiImageUrl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const img = new (win as any).Image() as HTMLImageElement;
      img.onload = () => {
        ctx.globalAlpha = 0.4;
        ctx.drawImage(img, 0, 0, dispW, dispH);
        ctx.globalAlpha = 1;
        renderComponents(ctx, comps, dispW, dispH, scaleDisplay, maskScaleX, maskScaleY);
      };
      img.src = data.roiImageUrl;
    } else {
      renderComponents(ctx, comps, dispW, dispH, scaleDisplay, maskScaleX, maskScaleY);
    }

    card.appendChild(canvas);
    const lbl = doc.createElement('div');
    lbl.className = 'label';
    lbl.textContent = `Mask ${mi} — ${comps.length} comp.`;
    card.appendChild(lbl);
    row.appendChild(card);
    block.appendChild(row);
  }

  // ─── Final result row ───
  const finalSubtitle = doc.createElement('h2');
  finalSubtitle.textContent = `Resultado final: ${data.finalComponents.length} raíces (tras erosión + cluster + dedup)`;
  finalSubtitle.style.color = '#00d4aa';
  block.appendChild(finalSubtitle);

  const finalRow = doc.createElement('div');
  finalRow.className = 'row';

  const finalCard = doc.createElement('div');
  finalCard.className = 'card selected';
  const finalCanvas = doc.createElement('canvas');
  finalCanvas.width = dispW;
  finalCanvas.height = dispH;
  const fCtx = finalCanvas.getContext('2d')!;
  fCtx.fillStyle = '#111';
  fCtx.fillRect(0, 0, dispW, dispH);

  if (data.roiImageUrl) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img2 = new (win as any).Image() as HTMLImageElement;
    img2.onload = () => {
      fCtx.globalAlpha = 0.4;
      fCtx.drawImage(img2, 0, 0, dispW, dispH);
      fCtx.globalAlpha = 1;
      renderComponents(fCtx, data.finalComponents, dispW, dispH, scaleDisplay, maskScaleX, maskScaleY);
    };
    img2.src = data.roiImageUrl;
  } else {
    renderComponents(fCtx, data.finalComponents, dispW, dispH, scaleDisplay, maskScaleX, maskScaleY);
  }

  finalCard.appendChild(finalCanvas);
  const fLabel = doc.createElement('div');
  fLabel.className = 'label';
  fLabel.textContent = `${data.finalComponents.length} raíces finales`;
  finalCard.appendChild(fLabel);
  finalRow.appendChild(finalCard);

  // Individual final component cards
  for (let ci = 0; ci < data.finalComponents.length; ci++) {
    const comp = data.finalComponents[ci];
    const [cr, cg, cb] = COMP_COLORS[ci % COMP_COLORS.length];
    const bw = comp.bbox.maxX - comp.bbox.minX + 1;
    const bh = comp.bbox.maxY - comp.bbox.minY + 1;
    const aspect = (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))).toFixed(1);

    const card = doc.createElement('div');
    card.className = 'card';
    const cardW = Math.max(60, Math.min(150, Math.round(bw * maskScaleX * scaleDisplay * 1.5)));
    const cardH = Math.max(60, Math.min(250, Math.round(bh * maskScaleY * scaleDisplay * 1.5)));
    const c = doc.createElement('canvas');
    c.width = cardW;
    c.height = cardH;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, cardW, cardH);

    const sxC = cardW / bw;
    const syC = cardH / bh;
    for (let my = comp.bbox.minY; my <= comp.bbox.maxY; my++) {
      for (let mx = comp.bbox.minX; mx <= comp.bbox.maxX; mx++) {
        if (comp.mask[my]?.[mx]) {
          const dx = Math.floor((mx - comp.bbox.minX) * sxC);
          const dy = Math.floor((my - comp.bbox.minY) * syC);
          const dw = Math.max(1, Math.ceil(sxC));
          const dh = Math.max(1, Math.ceil(syC));
          ctx.fillStyle = `rgba(${cr},${cg},${cb},0.8)`;
          ctx.fillRect(dx, dy, dw, dh);
        }
      }
    }

    card.appendChild(c);
    const lbl = doc.createElement('div');
    lbl.className = 'label';
    lbl.textContent = `#${ci + 1} — ${comp.area}px`;
    card.appendChild(lbl);
    const sc = doc.createElement('div');
    sc.className = 'score';
    sc.textContent = `${bw}×${bh} asp:${aspect}`;
    card.appendChild(sc);
    finalRow.appendChild(card);
  }

  block.appendChild(finalRow);
  container.insertBefore(block, container.firstChild);
  win.scrollTo(0, 0);
}
