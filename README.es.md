[English](README.md) · [Deutsch](README.de.md) · [中文](README.zh.md) · [日本語](README.ja.md) · **Español** · [Français](README.fr.md)

# Garmin Health Sync

Sincroniza automáticamente pasos, sueño, frecuencia cardíaca, estrés, actividades y más desde Garmin Connect a Obsidian Daily Notes — como propiedades de frontmatter que puedes consultar con Dataview.

> **Funciona en escritorio y en móvil** (Windows, macOS, Linux, iOS, Android). Este plugin utiliza la API interna de Garmin Connect; no existe una API oficial de terceros. Inicias sesión con tu correo y contraseña de Garmin (y el código de verificación si usas la verificación en dos pasos). Si Garmin bloquea ese intento, hay un inicio de sesión alternativo en el navegador.

## Características

- **Sincronización automática al iniciar** — comprueba los últimos 7 días y completa los datos de salud faltantes
- **Sincronización manual** — sincroniza cualquier Daily Note abierta mediante la paleta de comandos
- **Rellenado retroactivo** — sincronización masiva de un rango de fechas (p. ej., los últimos 3 meses)
- **Más de 20 métricas** — pasos, puntuación de sueño, HRV, estrés, Body Battery, SpO2, peso y más
- **Seguimiento de actividades** — cada entrenamiento aparece como un resumen legible
- **Ubicación del entrenamiento** — nombre del lugar obtenido por geocodificación inversa de tu primera actividad con GPS
- **Detección inteligente** — detecta automáticamente la ruta y el formato de tus Daily Notes desde Periodic Notes o el plugin nativo de Daily Notes
- **Soporte de subdirectorios** — encuentra Daily Notes existentes en carpetas anidadas (p. ej., `Journal/2024-07/`) y crea subcarpetas por fecha cuando el formato del nombre de archivo contiene `/` (p. ej., `YYYY/YYYY-MM-DD` → `Journal/2026/2026-08-04.md`)
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

**Body Battery:** `body_battery` es el valor *charged* de Garmin, la suma de todas las ganancias de Body Battery del día (sobre todo la recarga nocturna), no el nivel actual. Activa `body_battery_min` y `body_battery_max` para el nivel más bajo y más alto del día, que es lo que muestra la app de Garmin en su historial.

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

## Requisitos

- **Obsidian** en Windows, macOS, Linux, iOS o Android
- **Cuenta de Garmin** con acceso a Garmin Connect
- Plugin **Daily Notes** o **Periodic Notes** activado (o configurar la ruta manualmente en los ajustes)

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

### Iniciar sesión

Abre los ajustes del plugin y elige **Garmin Connect**; después introduce tu correo y contraseña de Garmin (y el código de verificación si usas la verificación en dos pasos). El inicio de sesión funciona igual en escritorio y en móvil.

Garmin puede limitar los intentos repetidos desde un dispositivo; el plugin muestra entonces una cuenta atrás hasta el siguiente intento. Si el inicio de sesión está bloqueado, usa en su lugar **Usar inicio de sesión en el navegador**: inicias sesión en la página de Garmin en tu navegador, copias el texto de la página que contiene `ST-…` y pulsas el botón del portapapeles en el plugin (o lo pegas en el campo). Una vez iniciada la sesión, el plugin renueva la conexión por sí mismo, así que rara vez tendrás que volver a iniciar sesión.

### Dónde se guardan las notas

La **ruta de notas diarias** es la carpeta y el **formato de nota diaria** es el nombre de archivo en sintaxis [moment.js](https://momentjs.com/docs/#/displaying/format/), la misma convención que el plugin Daily Notes integrado. El formato puede contener `/` para anidar las notas en subcarpetas por fecha, y los corchetes mantienen el texto literal:

| Ruta | Formato | Resultado |
| --- | --- | --- |
| `Journal` | `YYYY-MM-DD` | `Journal/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM-DD` | `Journal/2026/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM/YYYY-MM-DD` | `Journal/2026/2026-08/2026-08-04.md` |
| `Journal` | `YYYY-MM-DD [Workout]` | `Journal/2026-08-04 Workout.md` |

Las subcarpetas que falten se crean automáticamente.

### Sincronización automática

Al iniciar Obsidian, el plugin comprueba los últimos 7 días y completa automáticamente los datos de salud faltantes. No requiere acción manual. Por defecto crea una nota diaria cuando falta.

Si otra herramienta gestiona tus notas diarias (Templater, el plugin Calendar, una sincronización externa), desactiva **Crear nota diaria si falta** en los ajustes. La sincronización automática espera entonces hasta que exista una nota diaria real (no vacía) y sincroniza en cuanto aparece; las notas placeholder vacías de 0 bytes se ignoran. La sincronización manual y el backfill siempre crean las notas que falten, independientemente de este ajuste.

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

## Datos y privacidad

Este plugin realiza solicitudes de red a dos servicios externos:

- **Garmin Connect** — introduces tu correo y contraseña (y un código de verificación si es necesario) en el plugin. Se envían únicamente a los servidores de inicio de sesión de Garmin (`sso.garmin.com`, o `sso.garmin.cn` para China) y el plugin nunca los guarda ni los registra. Tras iniciar sesión, el plugin guarda los tokens de Garmin en el almacén de secretos de Obsidian, que permanece en el dispositivo, por lo que no se sincronizan con otros dispositivos ni se incluyen en copias de seguridad del vault ni en Git. Solo si el almacén de secretos no está disponible o rechaza la escritura, el plugin los guarda en `data.json`. Trata estos tokens como un inicio de sesión: Garmin controla su duración. Cada dispositivo inicia sesión por separado. Si Garmin bloquea o limita el inicio de sesión, se ofrece un inicio de sesión en el navegador (inicias sesión en la página de Garmin en tu navegador y pegas el ticket de un solo uso). Las claves OAuth públicas necesarias para iniciar sesión se obtienen de `thegarth.s3.amazonaws.com` (con claves de respaldo incluidas si ese host no está disponible). **Cerrar sesión** borra los tokens guardados en este dispositivo.
- **Nominatim (OpenStreetMap)** — si la función **Ubicación del entrenamiento** está activada, las coordenadas GPS de tu primera actividad se envían a `nominatim.openstreetmap.org` para geocodificación inversa. Puedes desactivarlo en los ajustes, en **Ubicación del entrenamiento**.

No se envían datos a ningún otro servidor.

## Desarrollo

```bash
npm install
npm run dev    # modo vigilancia
npm run build  # compilación para producción
```
