[English](README.md) · [Deutsch](README.de.md) · [中文](README.zh.md) · [日本語](README.ja.md) · **Español** · [Français](README.fr.md)

# Garmin Health Sync

Sincroniza automáticamente pasos, sueño, frecuencia cardíaca, estrés, actividades y más desde Garmin Connect a Obsidian Daily Notes — como propiedades de frontmatter que puedes consultar con Dataview.

> **Solo escritorio.** Este plugin utiliza BrowserWindow de Electron para la autenticación de Garmin Connect y no funciona en dispositivos móviles.

## Características

- **Sincronización automática al iniciar** — comprueba los últimos 7 días y completa los datos de salud faltantes
- **Sincronización manual** — sincroniza cualquier Daily Note abierta mediante la paleta de comandos
- **Rellenado retroactivo** — sincronización masiva de un rango de fechas (p. ej., los últimos 3 meses)
- **Más de 20 métricas** — pasos, puntuación de sueño, HRV, estrés, Body Battery, SpO2, peso y más
- **Seguimiento de actividades** — cada entrenamiento aparece como un resumen legible
- **Ubicación del entrenamiento** — nombre del lugar obtenido por geocodificación inversa de tu primera actividad con GPS
- **Detección inteligente** — detecta automáticamente la ruta y el formato de tus Daily Notes desde Periodic Notes o el plugin nativo de Daily Notes
- **Soporte de subdirectorios** — encuentra Daily Notes existentes en carpetas anidadas (p. ej., `Journal/2024-07/`)
- **Detección automática del idioma** — el idioma de la interfaz se configura según el idioma de tu Obsidian (EN, DE, ZH, JA, ES, FR)
- **Datos estructurados opcionales** — campo `trainings` legible por máquina para consultas avanzadas con Dataview

## Salida de Frontmatter

### Métricas

```yaml
---
steps: 15185
resting_hr: 69
sleep_score: 81
sleep_duration: 7h 43min
hrv: 39
stress: 30
vo2_max: 48
workout_location: Bad Honnef, Deutschland
---
```

### Actividades

Cada entrenamiento se escribe como una clave de frontmatter con una cadena de resumen:

```yaml
---
hiking: 8.2 km · 157min · Ø105 bpm · 696 kcal
e_bike: 22.1 km · 65min · Ø112 bpm · 420 kcal
---
```

Solo los días con entrenamientos reales reciben claves de actividad — el plugin nunca sobrescribe contenido existente en tus notas.

### Entrenamientos (opcional, legible por máquina)

Activa "Entrenamientos legibles por máquina" en la configuración para añadir un campo `trainings` estructurado para consultas con Dataview:

```yaml
---
trainings:
  - type: hiking
    category: outdoor
    distance_km: 8.2
    duration_min: 157
    avg_hr: 105
    calories: 696
  - type: e_bike
    category: cycling
    distance_km: 22.1
    duration_min: 65
    avg_hr: 112
    calories: 420
---
```

## Instalación

### Desde Community Plugins (recomendado)

1. Abre Configuración de Obsidian → Community Plugins → Explorar
2. Busca "Garmin Health Sync"
3. Instala y activa el plugin
4. Inicia sesión en Garmin Connect en la configuración del plugin

### Manual

1. Descarga `main.js` y `manifest.json` de la [última versión](https://github.com/fcandi/garmin-health-sync/releases)
2. Crea la carpeta `.obsidian/plugins/garmin-health-sync/` en tu vault
3. Copia ambos archivos en esa carpeta
4. Activa el plugin en Configuración → Community Plugins

## Uso

### Sincronización automática

Al iniciar Obsidian, el plugin comprueba los últimos 7 días y completa automáticamente los datos de salud faltantes. No requiere acción manual.

### Sincronización manual

Abre una Daily Note y ejecuta **Garmin Health Sync: Sync current note** desde la paleta de comandos (Cmd/Ctrl+P).

### Rellenado retroactivo de datos históricos

¿Tienes años de datos en Garmin? Puedes sincronizar en masa cualquier rango de fechas:

1. Abre la paleta de comandos (Cmd/Ctrl+P)
2. Busca **"Rellenar datos de salud"** (Backfill health data)
3. Elige una fecha de inicio y una de fin
4. El plugin obtiene todos los datos de ese rango con limitación de velocidad para evitar la restricción de la API

## Normalización de claves de actividad

Los valores `typeKey` de Garmin se normalizan a claves canónicas más concisas:

| Clave del proveedor | Clave canónica | Categoría |
|---|---|---|
| `e_bike_fitness` | `e_bike` | cycling |
| `e_bike_mountain` | `e_mtb` | cycling |
| `resort_skiing_snowboarding` | `skiing` | winter |
| `backcountry_skiing_snowboarding` | `backcountry_skiing` | winter |
| `stand_up_paddleboarding` | `sup` | water |
| `fitness_equipment` | `gym_equipment` | gym |

Todas las demás claves de Garmin se mantienen sin cambios (p. ej., `hiking`, `running`, `cycling`, `swimming`, `strength_training`, `yoga`, ...).

### Categorías de actividad

A cada actividad se le asigna una categoría:

| Categoría | Ejemplos |
|---|---|
| `cycling` | cycling, e_bike, e_mtb, mountain_biking, indoor_cycling, road_biking |
| `running` | running, trail_running, treadmill, ultra_run |
| `walking` | walking, indoor_walking |
| `outdoor` | hiking, mountaineering, rock_climbing, bouldering |
| `swimming` | swimming, pool_swimming, open_water_swimming |
| `winter` | skiing, backcountry_skiing, cross_country_skiing, snowboarding |
| `water` | sup, rowing, kayaking, surfing, sailing |
| `gym` | strength_training, gym_equipment, elliptical, yoga, pilates, hiit |
| `racket` | tennis, badminton, squash, table_tennis, pickleball |
| `team` | soccer, basketball, volleyball, rugby |
| `other` | golf, meditation, multi_sport |

## Desarrollo

```bash
npm install
npm run dev    # modo vigilancia
npm run build  # compilación para producción
```
