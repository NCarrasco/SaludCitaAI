"""SaludCita AI — servidor de la interfaz del paciente (FastAPI + Gradio montado).

Acceso sin registro previo:
- Al abrir la página, si el navegador no trae una sesión válida, este servidor crea una sesión invitada en la API
  con su credencial de servicio (scope «gateway») y la guarda en una cookie HttpOnly (`sc_device`).
  La credencial de servicio nunca llega al navegador; el token de sesión tampoco es accesible desde JavaScript.
- /acceso/recuperar canjea un código de recuperación (un solo uso; la API emite uno nuevo que se muestra una vez).
- /acceso/demo entra con una cuenta ficticia de demostración; /acceso/salir cierra la sesión del dispositivo.
- Las rutas /acceso/* exigen la cabecera propia `x-saludcita-ui` y, si llega, un Origin del mismo sitio:
  un formulario de otro sitio no puede enviarlas.
- Ni los códigos ni los tokens se registran en logs ni viajan en URLs.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import gradio as gr
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from api_client import ApiError, ApiClient
from app import CSS, HEAD, SESSION_COOKIE, THEME, demo

api = ApiClient()
GATEWAY_TOKEN = os.environ.get("GRADIO_GATEWAY_TOKEN", "")
GATEWAY_BEARER = GATEWAY_TOKEN if GATEWAY_TOKEN.startswith("svc_") else f"svc_{GATEWAY_TOKEN}"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
TRUST_PROXY = os.environ.get("GRADIO_TRUST_PROXY_HEADERS", "false").lower() == "true"
PENDING_TTL = 300

# Código nuevo emitido al recuperar el acceso: se guarda en memoria del servidor (clave = hash del token de sesión)
# para mostrarlo una sola vez en la siguiente carga. Nunca se escribe en disco ni en logs.
_pending: dict[str, tuple[str, float]] = {}
_lock = threading.Lock()


def _key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def pop_pending_code(token: str) -> str | None:
    now = time.monotonic()
    with _lock:
        for k in [k for k, (_, exp) in _pending.items() if exp < now]:
            del _pending[k]
        item = _pending.pop(_key(token), None)
    return item[0] if item else None


def client_ip_from(headers: dict, host: str | None) -> str:
    """IP del visitante para los límites por IP. X-Forwarded-For solo detrás de un proxy de confianza."""
    if TRUST_PROXY:
        fwd = {k.lower(): v for k, v in headers.items()}.get("x-forwarded-for", "")
        if fwd.strip():
            return fwd.split(",")[0].strip()[:64]
    return (host or "desconocida")[:64]


def _client_ip(request: Request) -> str:
    return client_ip_from(dict(request.headers), request.client.host if request.client else None)


# Activación de la cookie tras recuperar el acceso DENTRO del chat (handler de Gradio, que no puede fijar cookies):
# el handler deja el token bajo un nonce aleatorio de un solo uso (60 s) y el navegador lo canjea en /acceso/activar.
_activations: dict[str, tuple[str, str, float]] = {}


def recover_in_chat(code: str, birth_date: str, ip: str, old_token: str | None) -> dict:
    """Canjea código + fecha de nacimiento con la credencial de la pasarela. Lanza ApiError (genérico) si falla."""
    r = api.gateway("recover", GATEWAY_BEARER, {"code": code, "birth_date": birth_date, "client_ip": ip})
    if old_token:
        try:
            api.logout(old_token)
        except ApiError:
            pass
    nonce = secrets.token_urlsafe(32)
    with _lock:
        now = time.monotonic()
        for k in [k for k, (_, _, exp) in _activations.items() if exp < now]:
            del _activations[k]
        _activations[nonce] = (r["token"], r["expires_at"], now + 60)
    return {**r, "nonce": nonce}


def _set_session_cookie(resp: Response, token: str, expires_at: str) -> None:
    try:
        max_age = int((datetime.fromisoformat(expires_at) - datetime.now(timezone.utc)).total_seconds())
    except ValueError:
        max_age = 3600
    resp.set_cookie(SESSION_COOKIE, token, max_age=max(60, max_age), httponly=True, samesite="lax",
                    secure=COOKIE_SECURE, path="/")


def _same_origin(request: Request) -> bool:
    if request.headers.get("x-saludcita-ui") != "1":
        return False
    origin = request.headers.get("origin")
    if origin is None:
        return True
    host = request.headers.get("x-forwarded-host") if TRUST_PROXY else None
    return urlsplit(origin).netloc == (host or request.headers.get("host"))


def _page(status: int, title: str, message: str) -> HTMLResponse:
    """Página mínima (sin recursos externos) para cuando no se puede abrir la sesión."""
    html = f"""<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SaludCita AI</title><style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f0edf8;font-family:system-ui,sans-serif;color:#17132b}}
.c{{max-width:420px;margin:16px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(17,27,33,.18)}}
.h{{background:#5b34d6;color:#fff;padding:14px 18px;font-weight:600}} .b{{padding:18px}} a{{color:#5b34d6}}

</style></head><body><div class="c" role="alert"><div class="h">SaludCita · {title}</div><div class="b"><p>{message}</p>
<p><a href="/">Volver a intentarlo</a></p></div></div></body></html>"""
    return HTMLResponse(html, status, headers={"cache-control": "no-store", "retry-after": "600"} if status == 429 else {"cache-control": "no-store"})


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"message": message}, status_code=status, headers={"cache-control": "no-store"})


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def guest_session(request: Request, call_next):
    """En la carga de la página: garantiza una sesión de dispositivo válida (invitada si no hay ninguna)."""
    if request.method != "GET" or request.url.path not in ("/chat", "/chat/"):
        return await call_next(request)
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        try:
            await run_in_threadpool(api.me, token)
            return await call_next(request)
        except ApiError as e:
            if e.status != 401:
                return _page(503, "Servicio no disponible", "El servicio de citas no está disponible. Inténtalo de nuevo en unos minutos.")
    try:
        s = await run_in_threadpool(api.gateway, "guest-sessions", GATEWAY_BEARER, {"client_ip": _client_ip(request)})
    except ApiError as e:
        if e.status == 429:
            return _page(429, "Demasiadas sesiones nuevas", "Se han abierto demasiadas sesiones nuevas desde esta red en la última hora. "
                         "Espera un rato. Si ya tenías citas, podrás recuperarlas con tu código de recuperación cuando vuelvas a entrar.")
        return _page(503, "Servicio no disponible", "El servicio de citas no está disponible. Inténtalo de nuevo en unos minutos.")
    # Las peticiones posteriores de Gradio (cola y eventos) enviarán ya esta cookie
    resp = await call_next(request)
    _set_session_cookie(resp, s["token"], s["expires_at"])
    resp.headers["cache-control"] = "no-store"
    return resp


@app.post("/acceso/recuperar")
async def recover(request: Request):
    if not _same_origin(request):
        return _error(403, "Solicitud no permitida.")
    body = await request.json()
    code = str(body.get("code", "")).strip()
    if not 10 <= len(code) <= 60:
        return _error(400, "Escribe el código de recuperación completo.")
    try:
        r = await run_in_threadpool(api.gateway, "recover", GATEWAY_BEARER, {"code": code, "client_ip": _client_ip(request)})
    except ApiError as e:
        if e.status == 429:
            return _error(429, "Demasiados intentos. Espera unos minutos antes de volver a probar.")
        if e.status == 401:
            return _error(401, "El código no es válido, ya se usó o caducó.")
        return _error(503, "No se pudo recuperar el acceso. Inténtalo de nuevo.")
    await _end_previous(request)
    with _lock:
        _pending[_key(r["token"])] = (r["new_recovery_code"], time.monotonic() + PENDING_TTL)
    resp = JSONResponse({"ok": True}, headers={"cache-control": "no-store"})
    _set_session_cookie(resp, r["token"], r["expires_at"])
    return resp


@app.post("/acceso/activar")
async def activate(request: Request):
    if not _same_origin(request):
        return _error(403, "Solicitud no permitida.")
    body = await request.json()
    with _lock:
        item = _activations.pop(str(body.get("nonce", "")), None)
    if not item or item[2] < time.monotonic():
        return _error(400, "Activación no válida o caducada.")
    resp = JSONResponse({"ok": True}, headers={"cache-control": "no-store"})
    _set_session_cookie(resp, item[0], item[1])
    return resp


@app.get("/comprobante/{appointment_id}")
async def receipt(appointment_id: str, request: Request):
    """Descarga del comprobante: solo con la sesión del dispositivo; la API comprueba que la cita es del paciente."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token or not re.fullmatch(r"[0-9a-f-]{36}", appointment_id):
        return _page(401, "Sin sesión", "Abre el chat en este dispositivo para descargar tus comprobantes.")
    try:
        pdf, name = await run_in_threadpool(api.receipt_pdf, token, appointment_id)
    except ApiError as e:
        if e.status == 409:
            return _page(409, "Comprobante en preparación", str(e))
        return _page(404, "Comprobante no disponible", "No encontramos ese comprobante entre tus citas.")
    return Response(pdf, media_type="application/pdf", headers={"content-disposition": f'attachment; filename="{name}"',
                                                                "cache-control": "private, no-store"})


@app.post("/acceso/demo")
async def demo_login(request: Request):
    if not _same_origin(request):
        return _error(403, "Solicitud no permitida.")
    body = await request.json()
    try:
        r = await run_in_threadpool(api.login, str(body.get("username", ""))[:64], str(body.get("password", ""))[:200])
    except ApiError as e:
        return _error(e.status if e.status in (401, 429) else 503, str(e))
    await _end_previous(request)
    resp = JSONResponse({"ok": True}, headers={"cache-control": "no-store"})
    _set_session_cookie(resp, r["token"], r["expires_at"])
    return resp


@app.post("/acceso/salir")
async def logout(request: Request):
    if not _same_origin(request):
        return _error(403, "Solicitud no permitida.")
    await _end_previous(request)
    resp = JSONResponse({"ok": True}, headers={"cache-control": "no-store"})
    resp.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=COOKIE_SECURE)
    return resp


async def _end_previous(request: Request) -> None:
    """Cierra en la API la sesión que el dispositivo tenía antes (si seguía viva)."""
    old = request.cookies.get(SESSION_COOKIE)
    if old:
        try:
            await run_in_threadpool(api.logout, old)
        except ApiError:
            pass


# Página del hospital simulado con el asistente flotante (abre /chat/ en un panel). El chat también funciona solo en /chat/.
_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


@app.get("/", include_in_schema=False)
async def inicio():
    with open(os.path.join(_ASSETS, "inicio.html"), encoding="utf-8") as f:
        return HTMLResponse(f.read(), headers={"cache-control": "no-cache"})


@app.get("/salu.svg", include_in_schema=False)
async def salu_svg():
    return FileResponse(os.path.join(_ASSETS, "robot.svg"), media_type="image/svg+xml", headers={"cache-control": "public, max-age=86400"})


app = gr.mount_gradio_app(app, demo.queue(default_concurrency_limit=8), path="/chat", theme=THEME, css=CSS, head=HEAD,
                          show_error=False, footer_links=[], ssr_mode=False,
                          allowed_paths=[os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")])
