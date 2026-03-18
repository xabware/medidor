import { useState, useCallback, useEffect } from 'react';
import { MedidorProvider } from './context/MedidorContext';
import { useMedidor } from './context/useMedidor';
import { ImageLoader } from './components/ImageLoader';
import { ImageEditor } from './components/ImageEditor';
import { MeasurementsPanel } from './components/MeasurementsPanel';
import { SAMModelSelector } from './components/SAMModelSelector';
import { compressImage } from './utils/imageCompression';
import { saveProject, loadProject } from './utils/projectFile';
import './App.css';

type MobileTab = 'images' | 'editor' | 'measurements';

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

function AppContent() {
  const [isROIMode, setIsROIMode] = useState(false);
  const [isCalibrationMode, setIsCalibrationMode] = useState(false);
  const [maxResolution, setMaxResolution] = useState<number | null>(1024);
  const [showTutorial, setShowTutorial] = useState(false);
  const [samModelId, setSamModelId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('editor');
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const isMobile = useIsMobile();
  const calibrationUnit = 'cm';
  const { images, setImages, currentImageId, setCurrentImage } = useMedidor();

  // Save / Load project
  const handleSave = useCallback(() => {
    saveProject(images, currentImageId, maxResolution);
  }, [images, currentImageId, maxResolution]);

  const handleLoad = useCallback(async () => {
    const result = await loadProject();
    if (!result) return;
    setImages(result.images);
    if (result.currentImageId && result.images.some(i => i.id === result.currentImageId)) {
      setCurrentImage(result.currentImageId);
    } else if (result.images.length > 0) {
      setCurrentImage(result.images[0].id);
    }
    if (result.maxResolution !== undefined) {
      setMaxResolution(result.maxResolution);
    }
  }, [setImages, setCurrentImage]);

  const handleResolutionChange = useCallback(async (newMaxDim: number | null) => {
    setMaxResolution(newMaxDim);

    // Reprocess all existing images with the new resolution (parallel)
    const updated = await Promise.all(images.map(async (img) => {
      const srcUrl = img.originalDataUrl ?? img.dataUrl;
      const srcW = img.originalWidth ?? img.width;
      const srcH = img.originalHeight ?? img.height;

      if (newMaxDim === null || (srcW <= newMaxDim && srcH <= newMaxDim)) {
        return {
          ...img,
          dataUrl: srcUrl,
          width: srcW,
          height: srcH,
          originalDataUrl: undefined,
          originalWidth: undefined,
          originalHeight: undefined,
          embeddingsModelId: img.dataUrl !== srcUrl ? undefined : img.embeddingsModelId,
        };
      } else {
        const result = await compressImage(srcUrl, newMaxDim);
        const changed = result.dataUrl !== img.dataUrl;
        return {
          ...img,
          originalDataUrl: srcUrl,
          originalWidth: srcW,
          originalHeight: srcH,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          embeddingsModelId: changed ? undefined : img.embeddingsModelId,
        };
      }
    }));
    setImages(updated);
  }, [images, setImages]);

  return (
    <div className="app-container">
      <header className="app-header">
        <h1 className="app-title">🌱 Medidor de Raíces</h1>

        {/* Desktop: show all header controls inline */}
        {!isMobile && (
          <>
            <SAMModelSelector onModelStateChange={(ready, modelId) => setSamModelId(ready ? modelId : null)} />
            <div className="resolution-selector" title="Resolución máxima de las imágenes cargadas">
              📐
              <select
                value={maxResolution === null ? 'original' : String(maxResolution)}
                onChange={(e) => {
                  const val = e.target.value;
                  handleResolutionChange(val === 'original' ? null : Number(val));
                }}
              >
                <option value="original">Original</option>
                <option value="4096">4096 px</option>
                <option value="3072">3072 px</option>
                <option value="2048">2048 px</option>
                <option value="1024">1024 px</option>
                <option value="512">512 px</option>
              </select>
            </div>
            <div className="header-actions">
              <button className="header-action-btn" onClick={handleSave} title="Guardar proyecto (.raiz)">
                💾 Guardar
              </button>
              <button className="header-action-btn" onClick={handleLoad} title="Cargar proyecto (.raiz)">
                📂 Cargar
              </button>
              <button className="tutorial-button" onClick={() => setShowTutorial(true)}>
                ❓ Tutorial
              </button>
            </div>
          </>
        )}

        {/* Mobile: hamburger menu */}
        {isMobile && (
          <button
            className="mobile-menu-btn"
            onClick={() => setShowMobileMenu(prev => !prev)}
            aria-label="Menú"
          >
            ☰
          </button>
        )}
      </header>

      {/* Mobile dropdown menu */}
      {isMobile && showMobileMenu && (
        <div className="mobile-menu-overlay" onClick={() => setShowMobileMenu(false)}>
          <div className="mobile-menu-panel" onClick={(e) => e.stopPropagation()}>
            <SAMModelSelector onModelStateChange={(ready, modelId) => setSamModelId(ready ? modelId : null)} />
            <div className="resolution-selector" title="Resolución máxima">
              📐
              <select
                value={maxResolution === null ? 'original' : String(maxResolution)}
                onChange={(e) => {
                  const val = e.target.value;
                  handleResolutionChange(val === 'original' ? null : Number(val));
                }}
              >
                <option value="original">Original</option>
                <option value="4096">4096 px</option>
                <option value="3072">3072 px</option>
                <option value="2048">2048 px</option>
                <option value="1024">1024 px</option>
                <option value="512">512 px</option>
              </select>
            </div>
            <div className="mobile-menu-actions">
              <button className="header-action-btn" onClick={() => { handleSave(); setShowMobileMenu(false); }}>
                💾 Guardar
              </button>
              <button className="header-action-btn" onClick={() => { void handleLoad(); setShowMobileMenu(false); }}>
                📂 Cargar
              </button>
              <button className="header-action-btn" onClick={() => { setShowTutorial(true); setShowMobileMenu(false); }}>
                ❓ Tutorial
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className={`app-layout ${isMobile ? 'app-layout-mobile' : ''}`}>
        <aside className={`sidebar left-sidebar ${isMobile && mobileTab !== 'images' ? 'mobile-hidden' : ''}`}>
          <ImageLoader 
            calibrationUnit={calibrationUnit}
            samModelId={samModelId}
            maxResolution={maxResolution}
            isROIMode={isROIMode}
            onStartROI={() => { setIsROIMode(true); if (isMobile) setMobileTab('editor'); }}
            isCalibrationMode={isCalibrationMode}
            onStartCalibration={() => { setIsCalibrationMode(true); if (isMobile) setMobileTab('editor'); }}
          />
        </aside>

        <main className={`main-content ${isMobile && mobileTab !== 'editor' ? 'mobile-hidden' : ''}`}>
          <ImageEditor
            samModelId={samModelId}
            isROIMode={isROIMode}
            onROIComplete={() => setIsROIMode(false)}
            isCalibrationMode={isCalibrationMode}
            onCalibrationComplete={() => setIsCalibrationMode(false)}
            calibrationUnit={calibrationUnit}
            isMobile={isMobile}
          />
        </main>

        <aside className={`sidebar right-sidebar ${isMobile && mobileTab !== 'measurements' ? 'mobile-hidden' : ''}`}>
          <div className="right-panel top-panel">
            <MeasurementsPanel calibrationUnit={calibrationUnit} />
          </div>
          <div className="right-panel bottom-panel" id="editor-tools-host" />
        </aside>
      </div>

      {/* Mobile bottom tab bar */}
      {isMobile && (
        <nav className="mobile-tab-bar">
          <button
            className={`mobile-tab ${mobileTab === 'images' ? 'mobile-tab-active' : ''}`}
            onClick={() => setMobileTab('images')}
          >
            <span className="mobile-tab-icon">📷</span>
            <span className="mobile-tab-label">Imágenes</span>
            {images.length > 0 && <span className="mobile-tab-badge">{images.length}</span>}
          </button>
          <button
            className={`mobile-tab ${mobileTab === 'editor' ? 'mobile-tab-active' : ''}`}
            onClick={() => setMobileTab('editor')}
          >
            <span className="mobile-tab-icon">🖌️</span>
            <span className="mobile-tab-label">Editor</span>
          </button>
          <button
            className={`mobile-tab ${mobileTab === 'measurements' ? 'mobile-tab-active' : ''}`}
            onClick={() => setMobileTab('measurements')}
          >
            <span className="mobile-tab-icon">📏</span>
            <span className="mobile-tab-label">Mediciones</span>
          </button>
        </nav>
      )}

      {showTutorial && (
        <div className="tutorial-overlay" onClick={() => setShowTutorial(false)}>
          <div className="tutorial-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tutorial-header">
              <h2>🎓 Tutorial de Uso</h2>
              <button className="close-button" onClick={() => setShowTutorial(false)}>✕</button>
            </div>
            <div className="tutorial-content">
              <section>
                <h3>📂 1. Cargar Imágenes</h3>
                <p>Arrastra y suelta imágenes o haz clic en la zona de carga para seleccionarlas desde tu ordenador. Por defecto, las imágenes se comprimen automáticamente a ≤1024px para agilizar el procesamiento.</p>
              </section>

              <section>
                <h3>📐 2. Resolución de imágenes</h3>
                <p>Usa el selector <strong>📐</strong> en la barra superior para elegir la resolución máxima de las imágenes: Original, 4096, 3072, 2048, 1024 o 512 px. Reducir la resolución agiliza el procesamiento. Por defecto: 1024 px.</p>
              </section>

              <section>
                <h3>📏 3. Calibrar</h3>
                <p>Haz clic en el botón <strong>📏</strong> junto a cada imagen. Dibuja una línea sobre el <strong>ancho</strong> de la superficie de referencia, introduce su medida real, y repite para el <strong>alto</strong>. Si las líneas no son perpendiculares, la imagen se normalizará automáticamente para corregir la perspectiva.</p>
              </section>

              <section>
                <h3>🖌️ 4. Medir Raíces</h3>
                <ul>
                  <li><strong>Botón izquierdo:</strong> Arrastra para dibujar mediciones sobre las raíces</li>
                  <li><strong>Botón derecho:</strong> Arrastra para desplazar la vista (pan)</li>
                  <li><strong>Rueda del ratón:</strong> Haz zoom in/out</li>
                  <li><strong>Extender mediciones:</strong> Pasa el ratón sobre los círculos en los extremos de una medición y arrastra para extenderla</li>
                </ul>
              </section>

              <section>
                <h3>🧠 5. Modelo SAM (preparación)</h3>
                <p>Carga un modelo SAM desde la barra superior y calcula los embeddings con el botón 🧠 junto a cada imagen. Los embeddings se guardan en caché para uso futuro con funcionalidades de segmentación.</p>
              </section>

              <section>
                <h3>⌨️ Atajos de Teclado</h3>
                <ul>
                  <li><strong>R:</strong> Restablecer zoom y centrar imagen</li>
                  <li><strong>Ctrl+Z:</strong> Deshacer última acción</li>
                  <li><strong>Ctrl+Shift+Z / Ctrl+Y:</strong> Rehacer acción</li>
                </ul>
              </section>

              <section>
                <h3>📊 6. Exportar Datos</h3>
                <p>En el panel derecho verás todas las mediciones. Haz clic en <strong>Exportar CSV</strong> para descargar los resultados.</p>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <MedidorProvider>
      <AppContent />
    </MedidorProvider>
  );
}

export default App;
