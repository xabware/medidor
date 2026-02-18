import React, { useState, useEffect, useCallback } from 'react';
import {
  SAM_MODELS,
  getDeviceSpecs,
  loadSAMModel,
  unloadSAMModel,
  isSAMReady,
  getLoadedModelId,
  clearEmbeddingsCache,
  type DeviceSpecs,
  type SAMModelInfo,
} from '../utils/samSegmentation';
import styles from './SAMModelSelector.module.css';

interface SAMModelSelectorProps {
  /** Called whenever the model-ready state changes (loaded / unloaded) */
  onModelStateChange?: (ready: boolean, modelId: string | null) => void;
}

export const SAMModelSelector: React.FC<SAMModelSelectorProps> = ({ onModelStateChange }) => {
  const [selectedModelId, setSelectedModelId] = useState(SAM_MODELS[0].id);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [deviceSpecs, setDeviceSpecs] = useState<DeviceSpecs | null>(null);
  const [modelReady, setModelReady] = useState(isSAMReady());

  // Detect device specs once
  useEffect(() => {
    setDeviceSpecs(getDeviceSpecs());
  }, []);

  // Sync external state
  const notifyState = useCallback(
    (ready: boolean) => {
      setModelReady(ready);
      onModelStateChange?.(ready, ready ? getLoadedModelId() : null);
    },
    [onModelStateChange],
  );

  const handleLoad = async () => {
    if (loading) return;

    // If already loaded with same model, unload
    if (modelReady && getLoadedModelId() === selectedModelId) {
      unloadSAMModel();
      notifyState(false);
      setStatusMsg('');
      return;
    }

    // If different model is loaded, unload first
    if (modelReady) {
      unloadSAMModel();
      clearEmbeddingsCache();
      notifyState(false);
    }

    setLoading(true);
    try {
      await loadSAMModel(selectedModelId, (info) => {
        setStatusMsg(
          info.progress != null ? `${info.status} (${info.progress}%)` : info.status,
        );
      });
      notifyState(true);
      setStatusMsg('Modelo listo ✓');
      setTimeout(() => setStatusMsg(''), 3000);
    } catch (err) {
      setStatusMsg('');
      alert('Error al cargar el modelo: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const currentModel: SAMModelInfo | undefined = SAM_MODELS.find((m) => m.id === selectedModelId);

  return (
    <div className={styles.container}>
      {/* Model select */}
      <select
        className={styles.selector}
        value={selectedModelId}
        onChange={(e) => setSelectedModelId(e.target.value)}
        disabled={loading}
        title={currentModel?.description}
      >
        {SAM_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.size})
          </option>
        ))}
      </select>

      {/* Load / Unload button */}
      <button
        className={`${styles.loadBtn} ${modelReady && getLoadedModelId() === selectedModelId ? styles.loadBtnActive : ''}`}
        onClick={handleLoad}
        disabled={loading}
        title={
          modelReady && getLoadedModelId() === selectedModelId
            ? 'Descargar modelo de memoria'
            : 'Cargar modelo en memoria'
        }
      >
        {loading
          ? '⏳ Cargando…'
          : modelReady && getLoadedModelId() === selectedModelId
            ? '✓ Cargado'
            : '⬇ Cargar'}
      </button>

      {/* Status text */}
      {statusMsg && <span className={styles.statusText}>{statusMsg}</span>}

      {/* Info button */}
      <button className={styles.infoBtn} onClick={() => setShowInfo(true)} title="Info modelos y dispositivo">
        i
      </button>

      {/* Info overlay */}
      {showInfo && (
        <div className={styles.infoOverlay} onClick={() => setShowInfo(false)}>
          <div className={styles.infoPanel} onClick={(e) => e.stopPropagation()}>
            <h3>🧠 Modelos SAM disponibles</h3>

            {SAM_MODELS.map((m) => (
              <div key={m.id} className={styles.modelCard}>
                <h4>{m.name}</h4>
                <p>
                  <strong>Tamaño:</strong> {m.size}
                </p>
                <p>{m.description}</p>
                <p>
                  <strong>Recomendado:</strong> {m.recommended}
                </p>
              </div>
            ))}

            {deviceSpecs && (
              <div className={styles.deviceSection}>
                <h3>💻 Tu dispositivo</h3>
                <ul className={styles.specsList}>
                  <li>
                    <strong>CPU:</strong> {deviceSpecs.cpuCores} núcleos
                  </li>
                  <li>
                    <strong>RAM:</strong>{' '}
                    {deviceSpecs.ramGB != null ? `${deviceSpecs.ramGB} GB` : 'No detectada'}
                  </li>
                  <li>
                    <strong>GPU:</strong> {deviceSpecs.gpu}
                  </li>
                  <li>
                    <strong>WebGPU:</strong> {deviceSpecs.webGPU ? 'Sí ✓' : 'No disponible'}
                  </li>
                </ul>
              </div>
            )}

            <button className={styles.closeInfoBtn} onClick={() => setShowInfo(false)}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
