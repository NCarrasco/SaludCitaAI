"""Cliente HTTP de la API de SaludCita AI usado por el backend de Gradio.

El token de sesión del paciente vive solo en el servidor (gr.State); nunca se envía al navegador
ni al modelo. Toda operación de agenda pasa por la API, que valida identidad y reglas.
"""

from __future__ import annotations

import os
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

import httpx

API_BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8080/api/v1").rstrip("/")


log = logging.getLogger("saludcita.api")


@dataclass
class ApiError(Exception):
    status: int
    code: str
    message: str

    def __str__(self) -> str:  # mensaje apto para mostrar al paciente
        return self.message


class ApiClient:
    def __init__(self, base_url: str = API_BASE_URL, timeout: float = 15.0) -> None:
        self._http = httpx.Client(base_url=base_url, timeout=timeout)

    def _call(self, method: str, path: str, token: str | None = None, **kw: Any) -> Any:
        headers = kw.pop("headers", {})
        if token:
            headers["authorization"] = f"Bearer {token}"
        t0 = time.monotonic()
        try:
            r = self._http.request(method, path, headers=headers, **kw)
        except httpx.HTTPError as e:
            # Diagnóstico del 503 intermitente: tipo de error, ruta (sin parámetros) y duración; nunca datos ni tokens
            log.warning("api_unreachable tipo=%s ruta=%s %s duracion_ms=%d", type(e).__name__, method, path.split("?")[0],
                        int((time.monotonic() - t0) * 1000))
            raise ApiError(503, "api_unreachable", "No se pudo contactar con el servicio de citas. Inténtalo de nuevo.") from e
        if r.status_code >= 400:
            try:
                err = r.json()["error"]
                raise ApiError(r.status_code, err.get("code", "error"), err.get("message", "Error"))
            except (ValueError, KeyError):
                raise ApiError(r.status_code, "error", f"Error del servicio ({r.status_code})") from None
        return r.json() if r.content else None

    # --- sesión ---
    def login(self, username: str, password: str) -> dict:
        return self._call("POST", "/patient-auth/login", json={"username": username, "password": password})

    def logout(self, token: str) -> None:
        self._call("POST", "/patient-auth/logout", token)

    # --- conversación ---
    def send_text(self, token: str, text: str, reply_to: dict | None = None) -> dict:
        body = {"client_message_id": str(uuid.uuid4()), "text": text}
        if reply_to:
            body["reply_to"] = {"role": reply_to["role"], "text": reply_to["text"][:500]}
        return self._call("POST", "/conversation/messages", token, json=body)

    def send_action(self, token: str, action: dict) -> dict:
        return self._call("POST", "/conversation/messages", token, json={"client_message_id": str(uuid.uuid4()), "action": action})

    def get_update(self, token: str, update_id: str) -> dict:
        return self._call("GET", f"/conversation/updates/{update_id}", token)

    def history(self, token: str, limit: int = 30) -> dict:
        return self._call("GET", "/conversation", token, params={"limit": limit})

    # --- operaciones confirmadas por el paciente ---
    def prepare_intent(self, token: str, body: dict) -> dict:
        return self._call("POST", "/action-intents", token, json=body)

    def submit_intent(self, token: str, intent_id: str, intent_token: str, idempotency_key: str) -> dict:
        """Envía la confirmación a n8n (comando durable); el resultado se consulta con confirmation_status."""
        return self._call("POST", f"/action-intents/{intent_id}/submit", token,
                          json={"token": intent_token}, headers={"idempotency-key": idempotency_key})

    def confirmation_status(self, token: str, intent_id: str) -> dict:
        return self._call("GET", f"/action-intents/{intent_id}/confirmation", token)

    # --- consultas ---
    def appointments(self, token: str) -> list[dict]:
        return self._call("GET", "/appointments", token, params={"scope": "upcoming", "limit": 50})["items"]

    def notifications(self, token: str, limit: int = 30, unread_only: bool = False) -> dict:
        params = {"limit": limit}
        if unread_only:
            params["unread_only"] = "true"
        return self._call("GET", "/notifications", token, params=params)

    def archive_notification(self, token: str, notification_id: str) -> None:
        self._call("POST", f"/notifications/{notification_id}/archive", token)

    def read_all(self, token: str) -> None:
        self._call("POST", "/notifications/read-all", token)

    def mark_read(self, token: str, notification_id: str) -> None:
        self._call("POST", f"/notifications/{notification_id}/read", token)

    # --- ofertas de adelanto ---
    def offers(self, token: str) -> list[dict]:
        return self._call("GET", "/offers", token)["items"]

    def answer_offer(self, token: str, offer_id: str, action: str, idempotency_key: str) -> dict:
        """Envía la respuesta a n8n (comando durable offer.answer); el resultado se consulta con offer_answer_status."""
        return self._call("POST", f"/offers/{offer_id}/answer", token, json={"action": action},
                          headers={"idempotency-key": idempotency_key})

    def offer_answer_status(self, token: str, offer_id: str) -> dict:
        return self._call("GET", f"/offers/{offer_id}/answer", token)

    # --- sesión invitada y recuperación ---
    def me(self, token: str) -> dict:
        return self._call("GET", "/patient-auth/me", token)["patient"]

    def update_profile(self, token: str, full_name: str, birth_date: str, contact: str = "") -> dict:
        # Contacto: UNO de los dos; con «@» es correo, si no, teléfono. La API valida el formato.
        body = {"full_name": full_name, "birth_date": birth_date}
        c = (contact or "").strip()
        if c:
            body["email" if "@" in c else "phone"] = c
        return self._call("PATCH", "/patients/me", token, json=body)["patient"]

    def recovery_status(self, token: str) -> dict:
        return self._call("GET", "/patient-auth/recovery-code", token)

    def rotate_recovery_code(self, token: str) -> dict:
        return self._call("POST", "/patient-auth/recovery-code", token)

    def revoke_recovery_code(self, token: str) -> dict:
        return self._call("DELETE", "/patient-auth/recovery-code", token)

    def revoke_other_sessions(self, token: str) -> dict:
        return self._call("POST", "/patient-auth/sessions/revoke-others", token)

    # --- pasarela (credencial de servicio solo en el servidor de Gradio) ---
    def gateway(self, path: str, gateway_token: str, body: dict) -> dict:
        return self._call("POST", f"/gateway/{path}", gateway_token, json=body)

    # --- comprobantes (incremento E): siempre con la sesión del paciente; la API comprueba la propiedad ---
    def receipt_status(self, token: str, appointment_id: str) -> dict:
        return self._call("GET", f"/appointments/{appointment_id}/receipt", token)

    def retry_receipt(self, token: str, appointment_id: str) -> dict:
        return self._call("POST", f"/appointments/{appointment_id}/receipt/retry", token)

    def receipt_pdf(self, token: str, appointment_id: str) -> tuple[bytes, str]:
        try:
            r = self._http.get(f"/appointments/{appointment_id}/receipt.pdf", headers={"authorization": f"Bearer {token}"})
        except httpx.HTTPError as e:
            raise ApiError(503, "api_unreachable", "No se pudo contactar con el servicio de citas.") from e
        if r.status_code >= 400:
            try:
                err = r.json()["error"]
                raise ApiError(r.status_code, err.get("code", "error"), err.get("message", "Error"))
            except (ValueError, KeyError):
                raise ApiError(r.status_code, "error", f"Error del servicio ({r.status_code})") from None
        name = r.headers.get("content-disposition", "").split("filename=")[-1].strip('"') or "comprobante.pdf"
        return r.content, name
