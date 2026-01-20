# 🌱 Medidor de Raíces

Una herramienta web moderna para facilitar la medición de raíces en imágenes, desarrollada con React + Vite.

## Características

### ✨ Funcionalidades Principales

- **Carga de Imágenes**: Soporta carga múltiple de imágenes
- **Editor Visual**: Interfaz intuitiva con canvas para dibujar y medir
- **Herramienta de Dibujo**: Dibuja líneas curvas libres para marcar mediciones
- **Sistema de Calibración**: Calibra automáticamente la correspondencia entre píxeles y unidades reales
- **Exportación a CSV**: Descarga todos los datos de mediciones en formato CSV
- **Interfaz Responsiva**: Adaptada para diferentes tamaños de pantalla

### 🔧 Sistema de Calibración

El proceso de calibración es simple y directo:

1. **Activar Modo Calibración**: Marca la casilla "Modo calibración" en el panel derecho
2. **Dibujar Línea de Referencia**: Dibuja una línea recta sobre la imagen representando un objeto de tamaño conocido
3. **Indicar Tamaño Real**: Ingresa el tamaño real de esa línea en la unidad deseada (cm, mm, etc.)
4. **Guardar**: El sistema calcula automáticamente la relación píxeles/unidad para esa imagen

Una vez calibrada, todas las mediciones en esa imagen se convertirán automáticamente a unidades reales.

### 📊 Exportación de Datos

Descarga un archivo CSV con:

- Nombre de la imagen
- Número de medición
- Longitud en píxeles
- Factor de calibración
- Longitud real (en unidades calibradas)
- Timestamp

### 🚀 Preparado para IA

La arquitectura está diseñada para futuras implementaciones de:

- Detección automática de raíces usando visión artificial
- Sugerencias de áreas a medir
- Análisis automático con redes neuronales

## Instalación

### Requisitos

- Node.js 20.19+ o 22.12+
- npm o yarn

### Pasos

```bash
# Instalar dependencias
npm install

# Ejecutar en desarrollo
npm run dev

# Compilar para producción
npm run build

# Vista previa de producción
npm run preview
```

## Uso

### Interfaz Principal

La aplicación se divide en tres secciones:

#### Izquierda - Gestor de Imágenes

- Botón para cargar imágenes
- Lista de imágenes con thumbnails
- Información de cada imagen (tamaño, dimensiones)
- Opción de eliminar imágenes

#### Centro - Editor de Imágenes

- Canvas interactivo para dibujar
- Lista de mediciones realizadas
- Visualización de líneas de calibración (verde) y mediciones (rojo)

#### Derecha - Panel de Calibración

- Activar/desactivar modo calibración
- Información de calibración actual
- Campos para ingresar tamaño real y unidad
- Botón para exportar CSV
- Información del proyecto

### Flujo de Trabajo

1. **Cargar Imágenes**: Haz clic en "+ Cargar Imágenes" y selecciona una o más imágenes
2. **Calibrar (Opcional)**:
   - Activa "Modo calibración"
   - Dibuja una línea sobre un objeto de tamaño conocido
   - Ingresa el tamaño real
3. **Medir**: Desactiva calibración y dibuja líneas para marcar las mediciones
4. **Exportar**: Haz clic en "Descargar CSV" para exportar los datos

## Estructura del Proyecto

```bash
src/
├── components/          # Componentes de React
│   ├── ImageLoader.tsx # Carga y lista de imágenes
│   ├── ImageEditor.tsx # Editor con canvas
│   ├── CalibrationPanel.tsx # Panel de calibración
│   └── *.module.css    # Estilos de componentes
├── context/            # Context API para estado global
│   └── MedidorContext.tsx
├── types/              # Definiciones de tipos TypeScript
│   └── index.ts
├── utils/              # Funciones utilitarias
│   └── drawing.ts      # Lógica de dibujo y cálculos
├── App.tsx             # Componente principal
└── index.css           # Estilos globales
```

## API del Contexto (useMedidor)

```typescript
interface MedidorContextType {
  images: LoadedImage[];
  currentImageId: string | null;
  addImages: (files: File[]) => Promise<void>;
  removeImage: (imageId: string) => void;
  setCurrentImage: (imageId: string) => void;
  addMeasurement: (imageId: string, line: DrawingLine) => void;
  updateCalibration: (imageId: string, calibration: ImageCalibration) => void;
  removeMeasurement: (imageId: string, lineId: string) => void;
  getCurrentImage: () => LoadedImage | undefined;
}
```

## Tipos de Datos

### DrawingLine

```typescript
interface DrawingLine {
  id: string;
  points: DrawingPoint[];
  imageId: string;
  type: 'measurement' | 'calibration';
  pixelLength?: number;
  realLength?: number;
  timestamp: number;
}
```

### ImageCalibration

```typescript
interface ImageCalibration {
  imageId: string;
  calibrationLine?: DrawingLine;
  pixelsPerUnit?: number;
  timestamp: number;
}
```

## Funciones Utilitarias

### calculateDistance

Calcula la distancia euclidiana entre dos puntos.

### calculateTotalDistance

Calcula la distancia total de una serie de puntos (suma de segmentos).

### downloadCSV

Genera y descarga un archivo CSV con los datos proporcionados.

### drawLine, drawPoint

Dibuja elementos en el canvas del editor.

## Configuración de TypeScript

El proyecto utiliza configuración estricta de TypeScript incluyendo:

- `verbatimModuleSyntax`: Requiere importaciones explícitas de tipos
- `forceConsistentCasingInFileNames`: Fuerza consistencia en nombres de archivos
- `strict`: Modo estricto habilitado

## Futuras Mejoras

- [ ] Integración con modelos de visión artificial
- [ ] Detección automática de raíces
- [ ] Análisis estadístico de mediciones
- [ ] Almacenamiento en la nube
- [ ] Editor de calibración avanzado
- [ ] Múltiples unidades de medida
- [ ] Historial de proyectos
- [ ] Compatibilidad con formatos adicionales (TIFF, BMP, etc.)

## Soporte

Para reportar errores o sugerir mejoras, por favor abre un issue en el repositorio.

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
