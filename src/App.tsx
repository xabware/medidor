import { useState } from 'react';
import { MedidorProvider } from './context/MedidorContext';
import { ImageLoader } from './components/ImageLoader';
import { ImageEditor } from './components/ImageEditor';
import { MeasurementsPanel } from './components/MeasurementsPanel';
import './App.css';

function AppContent() {
  const [isCalibrationMode, setIsCalibrationMode] = useState(false);
  const [isCropMode, setIsCropMode] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const calibrationUnit = 'cm';

  return (
    <div className="app-container">
      <header className="app-header">
        <h1 className="app-title">🌱 Medidor de Raíces</h1>
        <button className="tutorial-button" onClick={() => setShowTutorial(true)}>
          ❓ Tutorial
        </button>
      </header>
      
      <div className="app-layout">
        <aside className="sidebar left-sidebar">
          <ImageLoader 
            onStartCalibration={() => setIsCalibrationMode(true)}
            onCancelCalibration={() => setIsCalibrationMode(false)}
            isCalibrationMode={isCalibrationMode}
            onStartCrop={() => setIsCropMode(true)}
            onCancelCrop={() => setIsCropMode(false)}
            isCropMode={isCropMode}
            calibrationUnit={calibrationUnit}
          />
        </aside>

        <main className="main-content">
          <ImageEditor
            isCalibrationMode={isCalibrationMode}
            onCalibrationComplete={() => setIsCalibrationMode(false)}
            isCropMode={isCropMode}
            onCropComplete={() => setIsCropMode(false)}
            calibrationUnit={calibrationUnit}
          />
        </main>

        <aside className="sidebar right-sidebar">
          <MeasurementsPanel calibrationUnit={calibrationUnit} />
        </aside>
      </div>

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
                <p>Arrastra y suelta imágenes o haz clic en la zona de carga para seleccionarlas desde tu ordenador.</p>
              </section>

              <section>
                <h3>✂️ 2. Recortar Imagen (Opcional)</h3>
                <p>Haz clic en el botón <strong>✂️</strong> junto a la imagen para activar el modo recorte. Arrastra un rectángulo sobre la imagen original para seleccionar la región de interés.</p>
              </section>

              <section>
                <h3>📏 3. Calibrar</h3>
                <p>Haz clic en el botón <strong>📏</strong> para activar el modo calibración. Dibuja una línea sobre un objeto de longitud conocida e introduce la medida real en {calibrationUnit}.</p>
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
                <h3>🔍 5. Detección Automática</h3>
                <p>Haz clic en <strong>🔍 Detectar raíces</strong> para que el sistema analice automáticamente la imagen y detecte las raíces. Podrás seleccionar cuántas raíces agregar.</p>
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
