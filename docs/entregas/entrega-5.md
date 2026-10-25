# Entrega 5: verificación y reproducibilidad

Fecha: 23/24-oct-2026. Todo en local; sin despliegue ni push.

> **Google Calendar sigue PENDIENTE.** Hay un workflow importado y pruebas con un cliente simulado, que no equivalen a una integración terminada.

| Punto | Resultado | Evidencia |
|---|---|---|
| 1. Instalación desde copia limpia | ✅ Con volúmenes nuevos y solo el README: migraciones 0001–0007, seed, 3 workflows (2 publicados), humo 16/16, API 101/101, interfaz 10/10 y build sin caché en 137 s. Se encontraron y corrigieron 2 defectos | instalacion-limpia.md (carpeta de evidencias) |
| 2. Backup y restauración separada | ✅ Copia cifrada; restauración en otro proyecto; todos los conteos coinciden; logins, workflows y **recuperación de trabajos** verificados; desarrollo intacto | backup-restauracion.md (carpeta de evidencias) |
| 3. Pruebas de interfaz | ✅ 10/10 en Playwright (login y permisos en escritorio y móvil, reserva, cancelación, oferta, agenda sin modificar la cita) | pruebas-interfaz.txt (carpeta de evidencias) |
| 4. Aclaraciones y evaluación | ✅ Batería reservada congelada antes (commit `1a78db9`). Modelo 7/24 · reglas 24/24 · sistema 21/24 aceptables (11 directos + 10 aclaraciones, 3 fallos) | [evaluacion-ia-local.md §6](../evaluacion-ia-local.md) |
| 5. Demo trazable | ✅ 12/12 con ejecuciones reales de n8n y registro de Ollama | demo-trazable.md (carpeta de evidencias), [guion-demo.md](../guion-demo.md) |
| 6. Google Calendar OAuth | ⛔ Pasos exactos documentados; falta la configuración del equipo | [google-calendar.md](../google-calendar.md) |
| 7. Vínculo de calendario por médico | ✅ Panel (auditado) y comando `calendar-bind` | `maintenance.test.ts` |
| 8. Guía de Contabo | 🟡 Preparada y validada (`compose.prod.yaml`, Caddyfile); no desplegada; medición del modelo pendiente | [despliegue-contabo.md](../despliegue-contabo.md) |

**Defectos encontrados y corregidos:**

- La prueba de servido del panel dependía de un build local.
- Faltaba documentar las carpetas no compartidas con Docker.
- El planificador de n8n no guardaba sus ejecuciones correctas (sin trazabilidad).
- El ensayo de backup necesitaba la opción `--pause-writers` para comparar conteos.
- La regla «elección sin ordinal» se intentó y **se revirtió** por una regresión.

**Pendiente antes de cerrar el MVP:**

- Google Calendar real.
- Medición en Contabo.
- `git clone` real tras el commit.
- La ampliación de alcance del 23-oct (incrementos A–I).
