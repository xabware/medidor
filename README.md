# 🌱 Medidor de Raíces

Herramienta web para medir raíces en imágenes. React + TypeScript + Vite.

## Funcionalidades

- **Carga múltiple de imágenes** — drag & drop o selector de archivos
- **Resolución configurable** — selector en la barra superior (512 – 4096 px, u original)
- **Calibración** — dibuja una línea de referencia sobre un objeto conocido para convertir px → cm
- **Mediciones sobre canvas** — dibuja líneas curvas libres; extiende mediciones arrastrando sus extremos
- **Zoom / Pan** — rueda para zoom, botón derecho para desplazar
- **Deshacer / Rehacer** — historial independiente por imagen (Ctrl+Z / Ctrl+Shift+Z)
- **Modelo SAM (IA)** — carga SAM Base o Large en el navegador, define un ROI y calcula embeddings
- **Guardar / Cargar proyecto** — archivos `.raiz` (JSON) con imágenes, mediciones, calibraciones y ROIs
- **Exportar CSV** — descarga todas las mediciones en formato CSV (separador `;`, compatible con Excel ES)

## Tecnologías

| Capa | Tecnología |
| ------ | ----------- |
| Framework | React 18 + TypeScript |
| Build | Vite |
| IA | @huggingface/transformers (SAM vit-base / vit-large) |
| Inferencia | ONNX WASM con proxy (Web Worker), cuantización int8 para modelos grandes |
| Estado | React Context API |
| Estilos | CSS Modules + CSS custom properties |

## Instalación

```bash
npm install
npm run dev       # desarrollo
npm run build     # producción
```

Requisitos: Node.js ≥ 20.

## Uso

1. **Cargar imágenes** → panel izquierdo (drag & drop o clic)
2. **Calibrar** (opcional) → botón 📏, dibuja línea sobre referencia conocida, indica medida real
3. **Medir** → dibuja líneas sobre las raíces con botón izquierdo
4. **SAM** (opcional) → carga modelo, define ROI (🔲), calcula embeddings (🧠)
5. **Exportar** → panel derecho → Descargar CSV
6. **Guardar** → 💾 en la barra superior genera un `.raiz`; 📂 para cargar

### Atajos de teclado

| Atajo | Acción |
| ------- | -------- |
| `R` | Restablecer zoom |
| `Ctrl+Z` | Deshacer |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Rehacer |

## Estructura

```text
src/
├─ components/        # ImageEditor, ImageLoader, MeasurementsPanel, SAMModelSelector
├─ context/           # MedidorContext (Provider + store + hook)
├─ types/             # Interfaces compartidas
├─ utils/             # drawing, imageCompression, samSegmentation, projectFile
├─ App.tsx            # Layout principal + header + tutorial
└─ App.css            # Design tokens y estilos globales
```

## Licencia

MIT
