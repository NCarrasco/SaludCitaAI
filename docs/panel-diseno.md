# Panel administrativo · diseño de la etapa de operación (24-oct-2026)

## Para quién y qué decide

Personal de consulta externa del hospital simulado, frente a la agenda del día. La portada responde, en este orden:
¿qué citas hay hoy y cuál es la próxima?, ¿qué acaba de reservarse o cambiar?, ¿qué necesita a alguien ahora?,
¿qué disponibilidad queda? El análisis por periodos queda en páginas aparte.

## Arquitectura de navegación (por tareas del personal)

```
PRINCIPAL                                   SECUNDARIO (Técnico, solo admin)
Inicio               operación de hoy       Sistema › Integraciones · Trabajos y reintentos · Diagnóstico del asistente
Citas                listado, detalle, historial, asistencia
Solicitudes de ayuda abiertas / resueltas
Estadísticas         › Actividad · Ocupación · Adelantos
Configuración        › Profesionales · Agenda · Centro · (Vista previa al paciente)
```

Por qué: el menú anterior mezclaba operación diaria (Citas, Ayuda), análisis repartido en tres entradas (Análisis,
Ocupación, Ofertas y asistente), configuración (Mantenimiento) y diagnóstico técnico (Integraciones y cola). Ahora
cada entrada es una tarea; el análisis se agrupa en una sola sección con pestañas; lo técnico queda aparte y protegido
en la API; y las métricas del modelo dejan de presentarse junto a las del servicio.

## Jerarquía y distribución de Inicio (mosaico)

```
HOY  ┌ Citas de hoy ◯ │ Asistencia registrada ◯ │ Horarios libres ◯ │ Próxima cita · Reservas registradas ┐
     └ cada aro = proporción real con su denominador escrito; ▲/▼ vs mismo día de la semana pasada ─────────┘
┌ Agenda del día ─────────┐ ┌ Reservas y cancelaciones ──┐ ┌ Pendientes ─────────────┐
│ mini calendario (elige  │ │ total ● + leyenda con cifras│ │ una fila por tipo y su  │
│ el día; punto = citas)  │ │ líneas: continua / discont. │ │ cantidad real + acción  │
│ línea de tiempo «ahora» │ ├ Ocupación de la semana ────┤ ├ Cobertura ──────────────┤
│                         │ │ barras apiladas con % dentro│ │ ◯ ocupación 7 d ◯ asist.│
└─────────────────────────┘ └────────────────────────────┘ └─────────────────────────┘
ACTIVIDAD  Movimientos [Actividad reciente | Próximas citas] · 5 por página
ANALÍTICA (plegada)  Ocupación por médico · Disponibilidad por especialidad · Estado de las citas (dona) · Ocupación por hora
```

Inspiración: dashboard de AgileApp (tira de métricas con variación, rankings con barra, analítica plegable) y
referencias de métricas clínicas (anillos, cifra con punto, barras apiladas con porcentaje). Todo con datos reales de
la API; ningún aro, barra o variación sin denominador.

## Paleta (compartida con el chat)

Violeta `#5b34d6` (marca y acciones), violeta suave `#ece6fd`, fondo lavanda `#f3f1f9`, turquesa `#0e8fa3` (segunda
serie), magenta `#c2185b` (cancelaciones y marca «ahora»), ámbar `#d18a1c` (avisos). El verde queda solo para «En
vivo» y para estados confirmados. Tema oscuro con variantes aclaradas (`#9b80ff`). Contraste verificado con axe.

- Operación y análisis separados: la portada nunca usa un periodo mezclado de pasado y futuro.
- «Citas hoy» es la agenda por **fecha de atención**; «Creadas hoy» son reservas por **fecha de operación**. Nunca se
  confunden.
- Cada indicador con acción útil abre el listado filtrado (p. ej., asistencia sin marcar → Citas filtradas).

## Sistema visual

Se conserva la identidad del panel (verde azulado del chat, papel claro, tipografía del sistema sin recursos externos).

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--brand` | `#0f766e` | `#2bb3a3` | Navegación activa, acciones primarias, ocupación |
| `--ink` | `#1d211f` | `#e8ebe6` | Texto |
| `--now` | `#c2410c` | `#fb923c` | **Solo** la marca «ahora» de la agenda y el estado «en vivo» |
| `--warn` / `--bad` | `#9a5b00` / `#b42318` | `#f1b75c` / `#ff8a80` | Alertas (siempre con texto, nunca solo color) |

- Tipografía: pila del sistema; escala 12 · 13 · 15 · 17 · 22 · 28 px. Cifras con `tabular-nums`; horas y referencias en
  monoespaciada. Los números grandes solo en la franja de indicadores de la portada.
- Densidad: tablas a 14 px con filas de 40 px; tarjetas con un único título y, si aplica, una acción.
- **Elemento distintivo:** la agenda de hoy como línea de tiempo vertical con la marca «ahora» que separa lo atendido de
  lo pendiente. Es lo que el personal mira; el resto se mantiene sobrio.
- Movimiento: ninguno decorativo. Las actualizaciones en vivo resaltan 1,2 s la fila nueva (desactivado con
  `prefers-reduced-motion`).
- Lenguaje: «horarios» (no «slots»), estados en español, detalles técnicos solo en «Sistema» (solo admin).

## Actualización

Eventos de servidor (SSE) autenticados con la sesión del panel. PostgreSQL avisa con `NOTIFY` tras cada commit
(triggers); **una** conexión `LISTEN` por proceso de la API, no por navegador. El evento solo dice qué cambió (tema,
tipo y, para operator/admin, el id de la cita); el navegador vuelve a pedir los datos a los endpoints autorizados.
