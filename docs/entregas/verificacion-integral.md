# I · Verificación integral (24-oct-2026)

Solo se verifica lo **implementado**. El MVP **no está cerrado**: ver los bloqueos al final y la [matriz de requisitos](../matriz-requisitos.md).

**Condiciones:** Mac con Apple M5 Pro; Docker Desktop con 4 CPU y 5,8 GiB de RAM compartidos con otros proyectos; disco virtual de Docker de 58,8 GB; qwen3:1.7b en CPU. Nada se desplegó en Contabo ni se hizo push.

## Resultados

| Verificación | Tipo | Resultado | Evidencia |
|---|---|---|---|
| API (Vitest), entorno de desarrollo | Simulada (modelo y n8n simulados, PostgreSQL real) | **172/172** | `evidencias/verificacion-integral/api.txt` |
| Contrato OpenAPI (Redocly) | Estática | Válido | `openapi.txt` |
| Interfaz (Playwright), entorno de desarrollo | Sistema real en local | **18/19**; el fallo (503 intermitente Gradio → API) pasó al repetirlo (3/3) | `interfaz.txt` |
| Prueba de humo | Integración real | Superada | `humo.txt` |
| Demo trazable (API → n8n → Ollama, ofertas, estadísticas) | Integración real | **12/12** | `demo-trazable.md` |
| Orquestación y comprobante con n8n real (caída, reinicio, lease, reprogramación, recordatorio, limpieza) | Integración real | **Todas superadas** | `evidencias/orquestacion/comprobacion-real.md` |
| Copia cifrada → restauración en otro proyecto | Real | Conteos idénticos al manifiesto: citas, eventos, pacientes, avisos, ofertas, auditoría, mensajes, 11 migraciones, 4 workflows, credenciales e historial de n8n. Comprobantes: 28/28 y **misma huella SHA-256** del último PDF. API restaurada `ready` | `restauracion-*.txt` |
| Instalación limpia desde una copia de los archivos versionables (proyecto nuevo, volúmenes y secretos nuevos) | Real | Migraciones 0001–0011, seed, 3 workflows publicados, modelo descargado (39 s), humo superado, **API 172/172**, **interfaz 19/19** (dependencias reinstaladas con `npm ci`) | `instalacion-limpia.txt` |
| Orquestación real sobre la instalación limpia | Integración real | **Todas superadas** (PDF en 510 ms, reinicio de n8n en 25 s, lease vencido → 2.º intento, n.º 2 tras reprogramar, recordatorio y limpieza) | `orquestacion-copia-limpia.md` |
| Evaluación de conversación independiente (`reserved-v5`) | Real (modelo) | 31/47 turnos; 0 citas por charla; textos generados 5/16 buenos | [evaluacion-ia-local.md §13](../evaluacion-ia-local.md) |

## No verificado

- **Descarga del PDF desde el entorno restaurado:** la cuenta elegida no tenía cita vigente con comprobante listo. La integridad de los PDF sí se comprobó por huella.
- **`git clone` real:** el trabajo de C, E y esta verificación aún no está en un commit. Se usó una copia equivalente (archivos versionables, sin `.env`, `node_modules` ni volúmenes). Debe repetirse con `git clone` tras el commit.
- **Build sin caché:** se reutilizaron capas de imagen; el build `--no-cache` se verificó en la entrega 5.
- **Fallo de generación del PDF con n8n real:** el camino fallo → reintento → `dead` → reintento del dueño está probado con n8n simulado y en la interfaz.

## Defectos y riesgos encontrados durante la verificación

1. **Disco de Docker lleno** (100 % de 58,8 GB), por imágenes de varios proyectos y de reconstrucciones. PostgreSQL de la instalación limpia falló con «No space left on device».
   - Se liberó espacio sin afectar a otros proyectos: 110 imágenes sin etiqueta de SaludCita y luego `docker image prune` (solo imágenes sin etiqueta y sin contenedor), de 1,0 GB a **12,2 GB libres**.
   - No se tocaron contenedores, volúmenes ni imágenes etiquetadas de otros proyectos.
   - **Recomendación:** limpiar periódicamente las imágenes sin etiqueta y vigilar el espacio antes de instalaciones o restauraciones.
2. **Datos personales en el historial de Git:** `Acta de reunión.pdf` (nombres reales del equipo) está versionado desde el primer commit (`9925d3e`). No se ha hecho push.
   - **Requiere decisión del equipo:** quitarlo del repositorio y reescribir el historial local antes de publicarlo.
3. **Presión de memoria:** Ollama aparece con `OOMKilled=true` en la VM de Docker compartida. Provocó fallos de modelo en evaluaciones y probablemente el 503 intermitente de la interfaz.
4. **Conversación:** dos afirmaciones falsas sobre el servicio en `reserved-v5` (fines de semana y comprobante), sin corregir para no ajustar contra la batería.

## Bloqueos restantes (el MVP no puede cerrarse)

| Bloqueo | Tipo |
|---|---|
| Conversación natural y multilingüe (D1, D2) | Pendiente: no cumple (calidad del modelo, enrutamiento y validación semántica) |
| Interfaz multilingüe (D3) | Pendiente: solo español |
| Voz (F, G) y OCR (H) | Bloqueados: componentes y recursos sin autorizar |
| Google Calendar real | Bloqueado: credencial OAuth y cuenta de prueba del equipo |
| Despliegue y medición en Contabo | Bloqueado: decisión del equipo |
| `git clone` real y limpieza del historial (acta) | Pendiente de commit y decisión del equipo |
