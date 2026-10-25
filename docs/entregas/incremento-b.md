# Incremento B (y adelanto de C, D y A2): chat tipo WhatsApp, conversación natural y flujo visible en n8n (24-oct-2026)

Diseño guiado por las skills `ui-ux-pro-max` (accesibilidad, objetivos táctiles de 44 px, contraste, iconos SVG y fuentes del sistema) y `emil-design-eng` (animaciones de 150 a 250 ms con ease-out fuerte, solo `transform`/`opacity`, `prefers-reduced-motion`).

## Qué funciona (verificado en local)

### Ventana de mensajería
- **Cabecera:**
  - cabecera verde con el robot animado (SVG propio que parpadea);
  - el nombre del paciente como píldora flotante;
  - botón de sonido y menú **⋮**.
- **Pestañas** Chat, Mis citas y Avisos dentro de la barra verde. **Avisos** lleva un **contador de no leídos** en tiempo real: sondeo cada 10 s, animación «pop» y sonido cuando llega un aviso nuevo.
- **Burbujas:**
  - burbujas con «cola», separadas por mensaje;
  - entran con una animación de 220 ms;
  - los horarios numerados aparecen dentro de la burbuja con una insignia circular.
- **«Escribiendo…» con tres puntos** mientras n8n y el modelo trabajan. Sustituye al texto «Procesando… (4 s)». Es un estado verificable: la petición está en curso.
- **Sonidos con Web Audio**, sin archivos: un clic suave al teclear, un tono al enviar y otro al recibir la respuesta a lo que se acaba de enviar. Se pueden silenciar.
- **Responder a un mensaje:** tocar una burbuja la cita sobre la barra de escritura (cancelable). El mensaje enviado muestra la cita y **el modelo la recibe como contexto**. Ejemplo real: «esa, la segunda», respondiendo a la lista, propuso el horario 2.
- **Tarjeta de confirmación:**
  - un título con icono;
  - filas «Especialidad y médico» y «Fecha y hora»;
  - interruptor de avisos;
  - nombre y **fecha de nacimiento con calendario**, uno debajo del otro;
  - botón principal a todo el ancho.
- **Mis citas y Avisos como tarjetas:**
  - en Mis citas, una tarjeta por cita con un bloque de calendario (día y mes) y el estado en español; las canceladas quedan plegadas;
  - en Avisos, un icono por tipo, la hora y un punto de «no leído».
- **Bandeja de avisos manejable con muchos avisos:**
  - filtros «Todos» y «No leídos» con su contador;
  - páginas de 10 con «Mostrar más (N)»;
  - tocar un aviso lo marca como leído y lo despliega si es largo (los textos largos se recortan a 3 líneas);
  - **✕ para quitarlo**: se archiva con `archived_at` (migración 0009) y no se borra, para conservar la trazabilidad;
  - «Marcar todo como leído» en una sola llamada.
  - API: `GET /notifications` con `offset` y `total`, `POST /notifications/{id}/archive` y `POST /notifications/read-all`.
- **Sin estados inventados:** no hay «en línea» ni marcas de leído. El modo de cada respuesta (IA, menú, verificado) ya no se muestra en el chat, a petición del usuario. Sigue registrado en la base de datos y en n8n.
- Modo oscuro y móvil (375 a 420 px) revisados con capturas. Fuentes del sistema, sin Google Fonts.

### Acceso transparente (ajuste del incremento A)
- **La pestaña «Tu acceso» desaparece.** Al abrir el chat se crea la sesión del dispositivo sin que el usuario haga nada.
- **Código de recuperación:** tras la **primera reserva**, el asistente entrega el código en el chat. Se muestra una sola vez y no se guarda en el historial de la API.
- **Recuperar en otro dispositivo, dentro del chat:**
  - el usuario pega el código; la burbuja lo oculta («••••••»);
  - el asistente pide la **fecha de nacimiento**;
  - la API exige que ambos coincidan;
  - la cookie del nuevo dispositivo se fija con un *nonce* de un solo uso (60 s).
- **El código nunca se envía a la conversación,** ni a n8n ni al modelo; la prueba lo comprueba. Nombre y fecha sin código no dan acceso.
- **Menú ⋮:** ver o renovar el código, recuperar citas, cerrar las demás sesiones, cuenta de demostración y cerrar sesión.

### Conversación natural (adelanto del incremento D) — **revisado el 24-oct: redacción desactivada por defecto**
- **Segunda llamada al modelo para redactar.** La API calcula la respuesta con datos verificados; el modelo **redacta el texto natural** (prompt `draft-v4`):
  - en un saludo, una ayuda o algo fuera de alcance, sustituye el texto;
  - con horarios o propuestas, solo añade una frase de introducción.
- **Validación independiente** de cada redacción (`draft.ts`). Se rechaza si contiene:
  - números, días u horas;
  - nombres de médicos;
  - referencias o enlaces;
  - afirmaciones de operaciones («te reservé»);
  - contenido clínico.
- Si la redacción se rechaza, se usa el texto determinista. El motivo se guarda.
- **La interpretación (`interp-v1`) no cambia** cuando no hay mensaje citado. Las baterías evaluadas siguen siendo válidas.
- **Revisión correctiva (24-oct).** Se evaluó con la nueva batería reservada `reserved-v3`: la redacción no mejoró el resultado y solo 2 de 6 textos fueron correctos. Queda **desactivada por defecto** y los saludos, agradecimientos y despedidas usan textos verificados naturales. Ver [evaluacion-ia-local.md §9](../evaluacion-ia-local.md).

### Flujo visible en n8n en tiempo real (adelanto del incremento C)
Cada mensaje es una ejecución con pasos numerados. Además, `saveExecutionProgress` guarda el progreso nodo a nodo.

1. **1 · Mensaje del paciente (webhook)**
2. **2 · API: tomar el mensaje y preparar el prompt.** Expone `correlation_id`, `mensaje_paciente` y `responde_a`.
3. **3 · Un mensaje a la vez**
4. **4 · Ollama: entender la intención.** JSON con la intención y los datos.
5. **5 · API: validar y decidir.** Devuelve `decision`: intención, datos extraídos, paso siguiente, qué se muestra y si habrá redacción.
6. **6 · ¿Redactar con el modelo?** Rama IF explícita.
7. **7 · Ollama: redactar la respuesta**
8. **8 · API: validar redacción y responder.** Devuelve `validacion`: aceptada o motivo del rechazo.
- Las ramas de error (5b y 8b) responden con el texto verificado.
- Si n8n cae a mitad de la redacción, el siguiente ciclo cierra el mensaje sin volver a interpretarlo.

Para verlo: abre http://127.0.0.1:5678 → workflow «SaludCita · Conversación (IA local)» → **Executions**, y escribe en el chat.

## Pruebas

| Prueba | Resultado |
|---|---|
| API (Vitest) | 123/123. `draft.test.ts` (13 pruebas): redacción, validación, rechazo, cierre sin redacción, 9-1-1, cita. `guest.test.ts` incluye la fecha de nacimiento |
| Interfaz (Playwright) | **13/13**: 10 en escritorio y móvil, más las 3 de invitado ejecutadas aparte para no agotar el límite de 5 canjes cada 15 min por IP |
| Bandeja (script Playwright con 81 avisos) | 10 → «Mostrar más (79)» → 20. Tocar un aviso no leído baja el contador. ✕ lo quita. El filtro «No leídos» funciona. Sin errores de consola |
| Real con n8n y Ollama | Saludo, «¿cómo estás?», petición de cita y respuesta citada pasan por los 8 nodos de n8n |
| Prueba de humo | Superada |

Capturas: `docs/evidencias/incremento-b/` (escritorio, móvil, oscuro, menú, Mis citas y Avisos).

## Limitaciones

- **Modelo `qwen3:1.7b`:** por decisión del usuario se mantiene la capacidad actual (Docker, unos 5,8 GB compartidos con otros proyectos).
  - La redacción es correcta, pero a veces genérica o repite el saludo.
  - La interpretación sigue cometiendo errores, por ejemplo «hoy» en una petición sin fecha.
  - Cada mensaje tarda unos 8 a 15 s: unos 4 a 5 s interpretar y otros 4 a 5 s redactar.
- **Falta la evaluación independiente de la redacción** con una batería reservada (incremento D). La validación automática solo comprueba la seguridad, no la calidad.
- Los estilos dependen de clases internas de Gradio 6.30. Al cambiar la agrupación de mensajes cambió la estructura y hubo que adaptar los selectores; se revisan con capturas.
- Los límites por IP afectan a las pruebas repetidas en local: 30 sesiones por hora y 5 canjes cada 15 min.

## Revisión correctiva previa al commit (24-oct-2026)

| Defecto encontrado | Corrección | Prueba |
|---|---|---|
| El contorno verde del campo se cortaba mientras se esperaba la respuesta | El indicador de progreso de Gradio toma el radio del campo, solo en `#sc-input`; no se oculta nada global | `estilos-contrato.spec.ts` (escritorio y móvil con teclado), capturas `campo-procesando-*.png` y `campo-foco-*.png` |
| El modelo añadía fechas («hoy») no dichas por el paciente | La fecha se ancla al texto (`groundedDatePhrase`) | Pruebas unitarias. `reserved-v3`: 0 fechas inventadas |
| Redacciones del modelo inexactas aunque pasaran el validador | Redacción limitada, validación contra el catálogo y redacción desactivada por defecto | `draft.test.ts` (16 pruebas) y `reserved-v3` |
| Una respuesta incierta podía acabar en un saludo genérico | Nunca se redacta sobre aclaraciones o sugerencias | `draft.test.ts` |
| El código de recuperación solo se protegía en Gradio | La API lo redacta en el texto y en el mensaje citado; la burbuja con código no se puede citar | `guest.test.ts` |
| Fuerza bruta de la fecha de nacimiento con un código conocido | Invalidación tras 5 fallos (migración 0010) | `guest.test.ts` |
| Clic por tecla activado por defecto | Preferencia independiente, desactivada por defecto | `estilos-contrato.spec.ts` |
| Contraste insuficiente (cabecera, pestañas, cita, pie) y conversación no desplazable con el teclado | Paleta AA, `tabindex` en el registro | axe en tema claro y oscuro |
| El menú ⋮ cerrado era alcanzable con Tab | `inert` mientras está cerrado | `estilos-contrato.spec.ts` |
| Pruebas que fallaban por compartir contadores de límites | Instancia e2e aislada con una IP por ejecución y una cuenta por prueba | Suite completa |
| La demo trazable fallaba justo después de medianoche | El script ya no mueve `offered_at` al día anterior | `demo-trazable.md` 12/12 |
