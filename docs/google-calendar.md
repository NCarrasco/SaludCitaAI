# Google Calendar: configuración OAuth y prueba real

> **Estado: PENDIENTE.** Hay un workflow importado (sin publicar) y pruebas de la cola con un cliente simulado. **Eso no equivale a una integración terminada.** Hasta completar la sección «Prueba real» con eventos verdaderos en una cuenta de prueba, el panel muestra «Pendiente de credenciales» y la matriz de requisitos mantiene la integración como no verificada.

## Qué se necesita (sin secretos por chat)

1. **Una cuenta de Google de prueba**, sin datos personales reales.
2. **Un proyecto de Google Cloud** con la Google Calendar API habilitada y un cliente OAuth. Lo crea el equipo; el *client secret* se pega solo dentro de n8n.
3. **Calendarios de prueba**, uno por médico ficticio que se quiera sincronizar. Sus **ID de calendario** no son secretos y pueden compartirse o escribirse directamente en el panel.

Nadie debe enviar por chat ni guardar en Git el *client secret*, tokens de acceso o de refresco, ni la contraseña de la cuenta.

## Paso 1: proyecto y cliente OAuth en Google Cloud

1. En https://console.cloud.google.com/ crea un proyecto (por ejemplo, `saludcita-demo`).
2. En **APIs y servicios → Biblioteca**, habilita **Google Calendar API**.
3. En **APIs y servicios → Pantalla de consentimiento OAuth**:
   - tipo **Externo**, estado **Prueba**;
   - añade la cuenta de prueba como **usuario de prueba**;
   - ámbito: `https://www.googleapis.com/auth/calendar`.
4. En **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo: **Aplicación web**.
   - URI de redirección autorizada:
     - local: `http://localhost:5678/rest/oauth2-credential/callback`;
     - en el despliegue, la que muestre n8n (`https://<dominio-n8n>/rest/oauth2-credential/callback`).
5. Copia el **ID de cliente** y el **secreto de cliente** solo para el paso 2. No los guardes en archivos del repositorio.

## Paso 2: credencial en n8n

1. Abre n8n (local: http://127.0.0.1:5678) e inicia sesión con la cuenta de propietario local.
2. **Credentials → Add credential → Google Calendar OAuth2 API**.
3. Nombre: `Google Calendar (cuenta de prueba) — CONFIGURAR` (debe coincidir exactamente). También puedes elegir la credencial a mano en los tres nodos de Google del workflow.
4. Pega el ID y el secreto de cliente. Pulsa **Sign in with Google** y autoriza con la **cuenta de prueba**. n8n cifra la credencial con `N8N_ENCRYPTION_KEY`.

## Paso 3: calendarios de prueba y vínculo por médico

1. En Google Calendar (cuenta de prueba), crea un calendario por médico ficticio, por ejemplo «SaludCita · Dra. Sosa (prueba)».
2. En **Configuración del calendario → Integrar el calendario**, copia el **ID del calendario** (`…@group.calendar.google.com`).
3. Vincula el calendario. Al habilitarlo, las citas futuras de ese médico se encolan para sincronizar. Hay dos opciones:
   - **Panel** (auditado): *Sistema → Integraciones → Calendarios de Google por médico*. Pega el ID y pulsa «Guardar y habilitar».
   - **Comando** (sin auditoría del panel):

     ```bash
     docker compose --env-file .env -f infra/compose.yaml exec api node dist/db/cli.js calendar-list
     ```

     ```bash
     docker compose --env-file .env -f infra/compose.yaml exec api node dist/db/cli.js calendar-bind <doctor_id> <id-del-calendario>
     ```

     Para deshabilitar, añade `--disable`.

## Paso 4: publicar el workflow

En n8n abre «SaludCita · Google Calendar (BORRADOR…)», comprueba que los nodos de Google usan la credencial del paso 2 y pulsa **Publish**. También puedes ejecutar esto con n8n detenido y reiniciar después:

```bash
docker compose --env-file .env -f infra/compose.yaml exec n8n n8n publish:workflow --id=scCalendar01
```

## Prueba real (pendiente de ejecutar)

Con un médico vinculado:

| Paso | Acción | Verificación |
|---|---|---|
| 1 | Reservar una cita de ese médico desde Gradio | Aparece un evento con ID `sc<uuid sin guiones>` en el calendario de prueba. El panel muestra `calendar_sync` en estado `synced` y versión 1 |
| 2 | Reprogramar la cita | El **mismo** evento cambia de hora. `synced_version` = 2 |
| 3 | Cancelar la cita | El evento desaparece. `synced_version` = 3 |
| 4 | Desconectar la red de n8n o revocar el token, y reservar | El trabajo falla, se reintenta con espera creciente y aparece en «Sistema › Trabajos y reintentos». Tras restaurar, converge |

Evidencias que deben guardarse en `docs/evidencias/entrega-5/google-calendar/`, sin datos personales:

- capturas del calendario de prueba (evento creado, movido y borrado);
- ejecuciones de n8n;
- la salida de `GET /api/v1/admin/integrations`.

Solo entonces se cambiará el estado a **verificado** en el README y en la matriz.

## Qué hace el workflow

Para cada trabajo `calendar.sync` reclamado, recibe de la API el estado **vigente** de la cita:

- si la cita está cancelada, hace `DELETE` del evento (404 o 410 cuentan como borrado);
- si no, hace `PUT` del evento con ID determinista; si no existe (404), hace `POST` creándolo con ese ID.

Después confirma (`ack`) o informa del fallo (`fail`) a la API.

- El evento solo contiene la referencia de la cita, la especialidad, el centro y las horas. **No incluye el nombre del paciente.**
- Las versiones antiguas se descartan.
- La versión sincronizada nunca retrocede.
- Las cuotas vigentes de la Calendar API están en https://developers.google.com/workspace/calendar/api/guides/quota
