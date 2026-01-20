import { useState } from 'react';
import { MedidorProvider } from './context/MedidorContext';
import { ImageLoader } from './components/ImageLoader';
import { ImageEditor } from './components/ImageEditor';
import { MeasurementsPanel } from './components/MeasurementsPanel';
import './App.css';

function AppContent() {
  const [isCalibrationMode, setIsCalibrationMode] = useState(false);
  const [isCropMode, setIsCropMode] = useState(false);
  const calibrationUnit = 'cm';

  return (
    <div className="app-container">
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
