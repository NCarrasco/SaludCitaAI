"""Confirmación orquestada por n8n en la interfaz (sin red: la API se sustituye por un doble en memoria).

Cubre: errores antes y después de registrar la orden, resultado incierto, reenvío idempotente de la MISMA orden,
fallo de la redacción del chat tras una reserva confirmada, y entrega única del código de recuperación en la primera
reserva (inmediata o diferida). Ejecutar dentro de la imagen de Gradio:
  docker compose ... run --rm --no-deps -v "$PWD/apps/demo-gradio:/app:ro" gradio python -m unittest discover -s tests -v
"""
import unittest

import app
from api_client import ApiError

RESULT = {"intent_id": "i1", "kind": "booking", "outcome": "booked",
          "appointment": {"id": "a1", "booking_reference": "SC-TEST01", "status": "booked",
                          "slot": {"label": "lunes, 26 de octubre de 2026, 8:30 a. m.", "doctor": {"display_name": "Dra. Prueba"}}}}


def down():
    return ApiError(503, "api_unreachable", "No se pudo contactar con el servicio de citas.")


class FakeApi:
    def __init__(self):
        self.submits = []          # (intent_id, key) de cada envío
        self.submit_errors = []    # errores a lanzar en los próximos envíos
        self.statuses = []         # respuestas (o errores) de confirmation_status, en orden; la última se repite
        self.send_action_error = None
        self.recovery_active = False
        self.rotations = 0
        self.rotate_error = None
        self.prepare_error = None

    def update_profile(self, token, name, birth):
        return {"kind": "guest", "profile_complete": True}

    def prepare_intent(self, token, body):
        if self.prepare_error:
            raise self.prepare_error
        return {"intent_id": "i1", "token": "int_secreto"}

    def submit_intent(self, token, intent_id, intent_token, key):
        self.submits.append((intent_id, key))
        if self.submit_errors:
            raise self.submit_errors.pop(0)
        return {"status": "queued", "intent_id": intent_id, "command_id": "c1", "correlation_id": "corr-0001-abcd"}

    def confirmation_status(self, token, intent_id):
        r = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        if isinstance(r, Exception):
            raise r
        return r

    def send_action(self, token, action):
        if self.send_action_error:
            raise self.send_action_error
        return {"reply": {"text": "Listo: tu cita SC-TEST01 con Dra. Prueba quedó confirmada para el lunes, 26 de octubre de 2026, 8:30 a. m.",
                          "menu": True}}

    # comprobante: listo de inmediato
    def appointments(self, token):
        return [{"id": "a1", "booking_reference": "SC-TEST01", "status": "booked"}]

    def receipt_status(self, token, appointment_id):
        return {"status": "ready", "receipt_number": 1, "size_bytes": 4096}

    def recovery_status(self, token):
        return {"active": self.recovery_active}

    def rotate_recovery_code(self, token):
        if self.rotate_error:
            raise self.rotate_error
        self.rotations += 1
        self.recovery_active = True
        return {"recovery_code": f"SCR-CODIGO{self.rotations}", "expires_at": "2026-11-23T00:00:00Z"}


def new_state(first_booking=True):
    st = app.new_state()
    st.update(token="tok", patient={"kind": "guest", "profile_complete": not first_booking}, confirm_key="clave-1",
              proposal={"kind": "booking", "slot_id": "s1", "summary": "Cardiología con Dra. Prueba (ficticia), lunes, 26 de octubre"})
    return st


def texts(chat):
    return "\n".join(m["content"] for m in chat if m["role"] == "assistant")


class Base(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        self._orig = (app.api, app.CONFIRM_WAIT_SECONDS, app.POLL_SECONDS)
        app.api, app.CONFIRM_WAIT_SECONDS, app.POLL_SECONDS = self.api, 0.0, 0.0

    def tearDown(self):
        app.api, app.CONFIRM_WAIT_SECONDS, app.POLL_SECONDS = self._orig

    def confirm(self, st, chat=None):
        out = app.confirm(False, "Ana Prueba", "1990-05-17", st, chat or [])
        return out[0], out[1]

    def tick(self, st, chat):
        s2, c2 = app.watch_confirmation(st, chat)
        return st, (chat if not isinstance(c2, list) else c2)


class AntesDeRegistrar(Base):
    def test_error_al_preparar_si_garantiza_sin_cambios(self):
        self.api.prepare_error = ApiError(409, "slot_taken", "El horario ya no está disponible")
        st, chat = self.confirm(new_state())
        self.assertIn("No hubo cambios", texts(chat))
        self.assertIsNone(st["order"])
        self.assertEqual(self.api.submits, [])

    def test_rechazo_4xx_del_envio_es_terminal(self):
        self.api.submit_errors = [ApiError(410, "intent_expired", "La confirmación caducó")]
        st, chat = self.confirm(new_state())
        self.assertIn("No hubo cambios", texts(chat))
        self.assertIsNone(st["order"])

    def test_red_caida_al_enviar_es_incierto_y_se_reenvia_la_misma_orden(self):
        self.api.submit_errors = [down()]
        self.api.statuses = [{"status": "confirmed", "result": RESULT}]
        st, chat = self.confirm(new_state())
        self.assertNotIn("No hubo cambios", texts(chat))
        self.assertIn("No pude verificar el resultado todavía", texts(chat))
        self.assertEqual(st["order"]["intent_id"], "i1")
        st, chat = self.tick(st, chat)                                     # el temporizador reenvía la MISMA orden
        self.assertEqual(self.api.submits, [("i1", "clave-1"), ("i1", "clave-1")])
        self.assertIn("quedó confirmada", texts(chat))
        self.assertIsNone(st["order"])


class DespuesDeRegistrar(Base):
    def test_error_al_consultar_no_afirma_sin_cambios_y_conserva_la_orden(self):
        self.api.statuses = [down()]
        st, chat = self.confirm(new_state())
        self.assertNotIn("No hubo cambios", texts(chat))
        self.assertIn("No pude verificar el resultado todavía", texts(chat))
        self.assertEqual((st["order"]["command_id"], st["order"]["correlation_id"]), ("c1", "corr-0001-abcd"))
        # Sigue el fallo temporal: el temporizador no escribe nada ni crea otra orden
        st, chat2 = self.tick(st, chat)
        self.assertEqual(chat2, chat)
        self.assertEqual(len(self.api.submits), 1)
        # Se recupera la API: se informa el resultado real
        self.api.statuses = [{"status": "confirmed", "result": RESULT}]
        st, chat3 = self.tick(st, chat2)
        self.assertIn("quedó confirmada", texts(chat3))
        self.assertEqual(len(self.api.submits), 1)

    def test_en_cola_y_luego_rechazo_terminal(self):
        self.api.statuses = [{"status": "queued"}]
        st, chat = self.confirm(new_state())
        self.assertIn("en cola", texts(chat))
        self.assertNotIn("No hubo cambios", texts(chat))
        self.api.statuses = [{"status": "expired", "error": {"code": "orchestration_timeout", "status": 410,
                                                             "message": "La operación no se procesó a tiempo"}}]
        st, chat = self.tick(st, chat)
        self.assertIn("No hubo cambios", texts(chat))
        self.assertIsNone(st["order"])

    def test_fallo_de_send_action_tras_reserva_confirmada_muestra_la_confirmacion_verificada(self):
        self.api.statuses = [{"status": "confirmed", "result": RESULT}]
        self.api.send_action_error = down()
        st, chat = self.confirm(new_state(first_booking=False))
        t = texts(chat)
        self.assertIn("quedó confirmada", t)
        self.assertIn("SC-TEST01", t)
        self.assertNotIn("No hubo cambios", t)
        self.assertIn("comprobante-SC-TEST01-n1.pdf", t)                    # el PDF también se entrega

    def test_no_se_puede_confirmar_otra_vez_mientras_hay_una_orden_en_curso(self):
        self.api.statuses = [{"status": "queued"}]
        st, chat = self.confirm(new_state())
        st["proposal"] = {"kind": "booking", "slot_id": "s2", "summary": "Otra opción"}
        st, chat = self.confirm(st, chat)
        self.assertEqual(len(self.api.submits), 1)


class CodigoDeRecuperacion(Base):
    def test_primera_reserva_inmediata_entrega_un_codigo(self):
        self.api.statuses = [{"status": "confirmed", "result": RESULT}]
        st, chat = self.confirm(new_state())
        self.assertIn("SCR-CODIGO1", texts(chat))
        self.assertEqual(self.api.rotations, 1)

    def test_primera_reserva_diferida_entrega_el_codigo_una_sola_vez(self):
        self.api.statuses = [{"status": "queued"}]
        st, chat = self.confirm(new_state())
        self.assertNotIn("SCR-", texts(chat))
        self.api.statuses = [{"status": "confirmed", "result": RESULT}]
        st, chat = self.tick(st, chat)
        self.assertIn("SCR-CODIGO1", texts(chat))
        for _ in range(3):                                                 # consultas repetidas del temporizador
            st, chat = self.tick(st, chat)
        self.assertEqual(self.api.rotations, 1)
        self.assertEqual(texts(chat).count("SCR-"), 1)

    def test_reserva_fallida_no_genera_codigo(self):
        self.api.statuses = [{"status": "failed", "error": {"code": "slot_taken", "status": 409, "message": "Horario ocupado"}}]
        st, chat = self.confirm(new_state())
        self.assertEqual(self.api.rotations, 0)
        self.assertNotIn("SCR-", texts(chat))

    def test_fallo_al_generar_ofrece_recuperacion_explicita_sin_reintentar_solo(self):
        self.api.statuses = [{"status": "confirmed", "result": RESULT}]
        self.api.rotate_error = down()
        st, chat = self.confirm(new_state())
        self.assertIn("Ver mi código de recuperación", texts(chat))
        self.assertIn("quedó confirmada", texts(chat))
        self.api.rotate_error = None
        for _ in range(3):
            st, chat = self.tick(st, chat)
        self.assertEqual(self.api.rotations, 0)                            # no rota por su cuenta

    def test_el_codigo_no_va_al_historial_de_la_api(self):
        sent = []
        orig = self.api.send_action
        self.api.send_action = lambda token, action: (sent.append(action), orig(token, action))[1]
        self.api.statuses = [{"status": "confirmed", "result": RESULT}]
        st, chat = self.confirm(new_state())
        self.assertIn("SCR-CODIGO1", texts(chat))
        self.assertFalse(any("SCR-" in repr(a) for a in sent))


if __name__ == "__main__":
    unittest.main()
