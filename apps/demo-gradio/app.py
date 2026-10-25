"""SaludCita AI — interfaz web del paciente (Gradio) con aspecto de mensajería.

Reglas de esta capa:
- Solo presentación. No contiene lógica de agenda: todo se consulta y ejecuta en la API.
- La sesión del dispositivo llega en una cookie HttpOnly (server.py); el token vive en gr.State (servidor).
- Las confirmaciones son botones explícitos: el backend prepara la intención y la confirma con
  la sesión del paciente y una clave de idempotencia. El modelo nunca confirma nada.
- El código de recuperación nunca se envía a la conversación (ni al modelo, ni a n8n): se intercepta aquí.
- El modo de cada respuesta (IA, menú, verificado) queda registrado en la API y el panel; no se muestra en el chat.
"""

from __future__ import annotations

import html
import os
import re
import time
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo
from functools import partial

import gradio as gr

from api_client import ApiClient, ApiError

api = ApiClient()
POLL_SECONDS = float(os.environ.get("UI_POLL_SECONDS", "0.7"))
UI_TIMEOUT_SECONDS = float(os.environ.get("UI_TIMEOUT_SECONDS", "90"))
MAX_OPTIONS = 3
MAX_SPECIALTIES = 16   # botones creados (Gradio necesita un número fijo)
SPECIALTY_PAGE = 5     # se muestran de entrada; el resto con «Ver más especialidades»
MAX_SUGGESTIONS = 4
SESSION_COOKIE = "sc_device"

MENU = [("Reservar cita", "book"), ("Mis citas", "my_appointments"), ("Cambiar cita", "reschedule"),
        ("Cancelar cita", "cancel"), ("Hablar con el personal", "handoff"), ("¿Qué puedo hacer?", "help")]

WELCOME = ("¡Hola! 👋 Soy **Salu**, la asistente virtual de **SaludCita**. Puedo ayudarte a reservar, cambiar o cancelar "
           "tus citas y responder tus preguntas sobre el hospital. Escríbeme con tus palabras, por ejemplo "
           "*quiero una cita con pediatría el martes*, o toca una opción de abajo.")

def welcome_text() -> str:
    """Bienvenida con el saludo de la hora local del hospital (buenos días / buenas tardes / buenas noches)."""
    h = datetime.now(ZoneInfo(os.environ.get("BUSINESS_TIMEZONE", "America/Santo_Domingo"))).hour
    hello = "¡Buenos días!" if 5 <= h < 12 else "¡Buenas tardes!" if 12 <= h < 19 else "¡Buenas noches!"
    return WELCOME.replace("¡Hola!", hello, 1)


TYPING = {"role": "assistant",
          "content": '<span class="sc-typing" role="status" aria-label="El asistente está escribiendo"><i></i><i></i><i></i></span>'}
CODE_RE = re.compile(r"\bSCR[\s-]*(?:[A-Z0-9]{5}[\s-]*){4}[A-Z0-9]{5}\b", re.IGNORECASE)
RECOVER_HINT_RE = re.compile(r"\b(recuperar|recupera|otro (tel[eé]fono|dispositivo|celular)|perd[ií] (mis|el) (citas|acceso|c[oó]digo))\b", re.I)


def sentence(text: str) -> str:
    """Termina una frase con punto sin duplicarlo («8:00 a. m.» ya termina en punto)."""
    return text if text.endswith(".") else f"{text}."


def new_state() -> dict:
    return {"token": None, "patient": None, "reply": None, "proposal": None, "confirm_key": None, "offers": [],
            "reply_to": None, "recover_code": None, "client_ip": None, "notif_limit": 10, "notif_filter": "all",
            "receipt_watch": None, "order": None, "recovery_due": False}


# Referencia de cita (SC-XXXXXXX) resaltada como en «Mis citas»; no toca los códigos de recuperación (SCR-…)
REF_RE = re.compile(r"(?<![`\w>-])(SC-[A-Z0-9]{4,})(?![`\w])")


# Línea de lista «• SC-XXXX · Especialidad con médico · fecha» → tarjeta compacta: referencia arriba, cada dato en su línea
LIST_LINE_RE = re.compile(r"^• (SC-[A-Z0-9]{4,}) · (.+)$", re.M)


def _appt_item(m: re.Match) -> str:
    parts = [p.strip() for p in m.group(2).split(" · ") if p.strip()]
    rest = "".join(f'<span class="sc-li-line">{esc(p)}</span>' for p in parts)
    return f'<div class="sc-li"><code>{esc(m.group(1))}</code>{rest}</div>'


def mark_refs(text: str) -> str:
    text = LIST_LINE_RE.sub(_appt_item, text or "")
    # En frases con una referencia, «·» se lee como texto normal: «la cita SC-…, Cardiología con…, lunes…»
    text = "\n".join(ln.replace(" · ", ", ") if REF_RE.search(ln) and "sc-li" not in ln else ln for ln in text.split("\n"))
    return REF_RE.sub(r"`\1`", text)


_SCHED_I18N = {
    "es": {"days": ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
           "full": ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"], "ini": ["L", "M", "X", "J", "V", "S", "D"],
           "title": "Horario de consulta", "closed": "Sin consulta", "and": "y",
           "note": "Son las franjas de cada médico, no horarios libres garantizados: las ausencias pueden cambiarlas. "
                   "Para ver horarios libres, toca «Reservar cita»."},
    "en": {"days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
           "full": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], "ini": ["M", "T", "W", "T", "F", "S", "S"],
           "title": "Consultation hours", "closed": "No consultations", "and": "and",
           "note": "These are each doctor’s scheduled hours, not guaranteed free slots: absences can change them. "
                   "To see free times, tap «Book appointment»."},
}


def _clock(hhmm: str, lang: str) -> str:
    h, m = (int(x) for x in hhmm.split(":")[:2])
    if lang == "en":
        return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"
    return f"{h % 12 or 12}:{m:02d} {'a. m.' if h < 12 else 'p. m.'}"


def _days_label(days: list[int], t: dict, key: str = "days") -> str:
    # Tres o más días seguidos se leen como rango: «lun a vie»
    if len(days) >= 3 and days == list(range(days[0], days[-1] + 1)):
        return f"{t[key][days[0] - 1]} {'to' if t['and'] == 'and' else 'a'} {t[key][days[-1] - 1]}"
    names = [t[key][d - 1] for d in days]
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} {t['and']} {names[-1]}"


def schedule_card(sch: dict, lang: str) -> str:
    """Tarjeta de horario: un bloque por médico con la semana (L…D) marcada y cada franja en su línea.
    El texto completo de la respuesta queda en el historial de la API; aquí solo cambia la presentación."""
    t = _SCHED_I18N["en" if lang == "en" else "es"]
    title = t["title"] + (f" · {esc(sch['specialty'])}" if sch.get("specialty") else "")
    blocks = []
    for d in sch.get("doctors", []):
        name = re.sub(r"\s*\((ficticio|ficticia|fictitious)\)", "", d["doctor"])
        on = {x for r in d["ranges"] for x in r["days"]}
        week = "".join(f'<span class="sc-wd{" on" if i + 1 in on else ""}">{c}</span>' for i, c in enumerate(t["ini"]))
        # Franjas con los mismos días en una sola fila: «Mar y jue · 8:00 – 12:00 · 1:00 – 4:00»
        by_days: dict[tuple, list[str]] = {}
        for r in d["ranges"]:
            by_days.setdefault(tuple(r["days"]), []).append(f'{_clock(r["start"], lang)} – {_clock(r["end"], lang)}')
        ranges = "".join(f'<li><span class="sc-r-days">{esc(_days_label(list(k), t))}</span><span class="sc-r-times">'
                         + "".join(f'<span class="sc-r-time">{x}</span>' for x in v) + '</span></li>' for k, v in by_days.items())
        spec = "" if sch.get("specialty") else f'<span>{esc(d["specialty"])}</span>'
        blocks.append(f'<div class="sc-sched-doc"><div class="sc-sched-who"><strong>{esc(name)}</strong>{spec}</div>'
                      f'<div class="sc-week">{week}</div><ul class="sc-ranges">{ranges}</ul></div>')
    closed = sch.get("closed_days") or []
    closed_html = (f'<p class="sc-sched-closed"><strong>{t["closed"]}:</strong> {esc(_days_label(closed, t, "full"))}</p>' if closed else "")
    return (f'<div class="sc-sched"><div class="sc-sched-head"><span class="sc-ico sc-sched-ico"></span>'
            f'<div><strong>{title}</strong><span>{esc(sch.get("center", ""))}</span></div></div>'
            f'{"".join(blocks)}{closed_html}<p class="sc-sched-note">{t["note"]}</p></div>')


def tidy_generated(text: str) -> str:
    """Texto redactado por el modelo: viñetas en línea («… • A • B») → una por línea, como lista de Markdown."""
    text = re.sub(r"\s+•\s+", "\n• ", text or "")
    lines = [("- " + ln[2:].strip()) if ln.startswith("• ") else ln for ln in text.split("\n")]
    out = "\n".join(lines)
    return re.sub(r"([^\n])\n- ", r"\1\n\n- ", out, count=1)   # línea en blanco antes de la lista


def bot_message(reply: dict) -> dict:
    if reply.get("generated") and not reply.get("schedule"):
        return {"role": "assistant", "content": mark_refs(tidy_generated(reply.get("text", "")))}
    if reply.get("schedule"):
        card = schedule_card(reply["schedule"], reply.get("lang") or "es")
        # Si el modelo redactó la respuesta (p. ej., «El Dr. Taveras atiende martes y jueves…»), va su texto y debajo la tarjeta
        lead = f'<p class="sc-sched-lead">{esc(reply.get("text", ""))}</p>' if reply.get("generated") else ""
        return {"role": "assistant", "content": lead + card}
    return {"role": "assistant", "content": mark_refs(reply.get("text", ""))}


def plain(text: str, limit: int = 280) -> str:
    """Texto plano para citar un mensaje (sin marcado ni HTML)."""
    t = re.sub(r"<[^>]+>", " ", text or "")
    t = re.sub(r"[*_`>#]+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def user_message(text: str, reply_to: dict | None = None) -> dict:
    if not reply_to:
        return {"role": "user", "content": text}
    who = "Tú" if reply_to["role"] == "user" else "SaludCita"
    return {"role": "user", "content": f"> **{who}**\n> {reply_to['text']}\n\n{text}"}


def esc(text: str) -> str:
    return html.escape(text or "", quote=True)


# ---------------------------------------------------------------------------
# Vista: una función produce el estado visual completo a partir de la última respuesta
# ---------------------------------------------------------------------------

def proposal_card(prop: dict) -> str:
    """Tarjeta de confirmación con los datos verificados de la propuesta (sin tokens)."""
    title = {"booking": "Confirma tu cita", "cancellation": "Confirma la cancelación", "reschedule": "Confirma el cambio"}[prop["kind"]]
    icon = {"booking": "cal", "cancellation": "cancel", "reschedule": "swap"}[prop["kind"]]
    summary = prop["summary"]
    rows = ""
    m = re.match(r"^(?P<who>.+?\))(?:,\s*)(?P<when>.+)$", summary) if prop["kind"] == "booking" else None
    if m:
        rows = (f'<div class="sc-card-row"><span class="sc-ico" style="--i:var(--i-user)"></span><div><b>Especialidad y médico</b>{esc(m["who"])}</div></div>'
                f'<div class="sc-card-row"><span class="sc-ico" style="--i:var(--i-clock)"></span><div><b>Fecha y hora</b>{esc(m["when"])}</div></div>')
    else:
        rows = f'<div class="sc-card-row"><span class="sc-ico" style="--i:var(--i-info)"></span><div>{esc(summary)}</div></div>'
    note = ("El horario no queda apartado hasta que confirmes; se vuelve a comprobar en ese momento."
            if prop["kind"] != "cancellation" else "La cancelación solo se hace al confirmar.")
    return (f'<div class="sc-card"><div class="sc-card-title"><span class="sc-ico" style="--i:var(--i-{icon})"></span>{title}</div>'
            f'{rows}<p class="sc-card-note">{note}</p></div>')


def quote_html(rt: dict | None) -> str:
    if not rt:
        return ""
    who = "Tú" if rt["role"] == "user" else "SaludCita"
    return f'<div class="sc-quote-box" aria-label="Respondiendo a un mensaje"><b>{who}</b>{esc(rt["text"])}</div>'


def view(st: dict, chat: list, status: str = "", clear_input: bool = False):
    reply = st.get("reply") or {}
    opts = reply.get("options") or []
    dates = reply.get("date_choices") or []
    specs = reply.get("specialty_choices") or []
    appts = reply.get("appointment_choices") or []
    prop = st.get("proposal")
    suggs = reply.get("suggestions") or []
    out = [st, chat, status]
    for i in range(MAX_SUGGESTIONS):
        sg = suggs[i] if i < len(suggs) else None
        out.append(gr.update(visible=bool(sg), value=sg["label"] if sg else ""))
    for i in range(MAX_OPTIONS):
        o = opts[i] if i < len(opts) else None
        out.append(gr.update(visible=bool(o), value=f"{o['index']} · {o['label']} · {o['doctor']}" if o else ""))
    out.append(gr.update(visible=bool(reply.get("more_options"))))
    out.append(gr.update(visible=bool(opts) and bool(reply.get("change_specialty"))))
    for i in range(2):
        d = dates[i] if i < len(dates) else None
        out.append(gr.update(visible=bool(d), value=d["label"].capitalize() if d else ""))
    shown = len(specs) if reply.get("_specs_all") else min(len(specs), SPECIALTY_PAGE)
    for i in range(MAX_SPECIALTIES):
        s = specs[i] if i < shown else None
        out.append(gr.update(visible=bool(s), value=s["name"] if s else ""))
    rest = len(specs) - shown
    out.append(gr.update(visible=rest > 0, value=f"Ver más especialidades ({rest})"))
    out.append(gr.update(visible=bool(appts), choices=[(a["label"], a["appointment_id"]) for a in appts], value=None))
    out.append(gr.update(visible=bool(appts)))
    out.append(gr.update(visible=bool(prop)))
    if prop:
        out.append(gr.update(value=proposal_card(prop)))
        out.append(gr.update(visible=prop["kind"] == "booking", value=False))
        need = prop["kind"] == "booking" and not (st.get("patient") or {}).get("profile_complete")
        out.append(gr.update(visible=need))
    else:
        out.append(gr.update(value=""))
        out.append(gr.update(visible=False, value=False))
        out.append(gr.update(visible=False))
    rt = st.get("reply_to")
    out.append(gr.update(visible=bool(rt)))
    out.append(gr.update(value=quote_html(rt)))
    out.append(gr.update(value="") if clear_input else gr.update())
    return tuple(out)


def apply_reply(st: dict, chat: list, reply: dict | None):
    st["reply"] = reply
    st["proposal"] = reply.get("proposal") if reply else None
    st["confirm_key"] = str(uuid.uuid4()) if st["proposal"] else None
    if reply:
        chat = chat + [bot_message(reply)]
    return st, chat


def require_login(st: dict):
    if not st.get("token"):
        raise ApiError(401, "unauthorized", "Tu sesión terminó. Recarga la página.")


def who_line(p: dict | None) -> str:
    p = p or {}
    name = p.get("full_name") or "Visitante"
    return name if p.get("kind") == "guest" else f"{name} · cuenta de demostración"


_MENU_LABEL = {item: label for label, item in MENU}
_ACTION_LABELS = [
    (re.compile(r"^\[Menú: (\w+)\]$"), lambda m: _MENU_LABEL.get(m[1], "Menú")),
    (re.compile(r"^\[Eligió opción (\d+)\]$"), lambda m: f"Opción {m[1]}"),
    (re.compile(r"^\[Eligió fecha (\d+)\]$"), lambda m: f"Fecha {m[1]}"),
    (re.compile(r"^\[Eligió especialidad\]$"), lambda m: "Especialidad elegida"),
    (re.compile(r"^\[Ver más horarios\]$"), lambda m: "Ver más horarios"),
    (re.compile(r"^\[Eligió cita\]$"), lambda m: "Esta cita"),
    (re.compile(r"^\[Resultado de confirmación\]$"), lambda m: "Confirmar"),
    (re.compile(r"^\[Descartó\]$"), lambda m: "Descartar"),
    (re.compile(r"^\[Eligió reservar\]$"), lambda m: "Reservar"),
]


def friendly(content: str) -> str:
    """Los botones se guardan con una etiqueta técnica para la trazabilidad; en el chat se muestra el texto del botón."""
    for rx, fn in _ACTION_LABELS:
        m = rx.match(content or "")
        if m:
            return fn(m)
    return content


# Mensaje de confirmación (es/en) → el comprobante PDF se entrega en el chat como documento, igual que en WhatsApp
CONFIRMED_RE = re.compile(r"(?:Listo: tu cita|Done: your appointment) `?(SC-[A-Z0-9]{4,})`?")


def receipt_doc(token: str, ref: str, items: list | None = None) -> tuple[str, dict | None]:
    """Estado REAL del comprobante vigente de la cita `ref`: ('ready', burbuja) · ('pending'|'failed'|'none', None)."""
    try:
        items = items if items is not None else api.appointments(token)
        a = next((x for x in items if x.get("booking_reference") == ref and x.get("status") == "booked"), None)
        if not a:
            return "none", None
        r = api.receipt_status(token, a["id"])
    except ApiError:
        return "none", None
    if r.get("status") != "ready":
        return r.get("status") or "none", None
    n = r.get("receipt_number")
    kb = max(1, round((r.get("size_bytes") or 0) / 1024))
    name = f"comprobante-{ref}-n{n}.pdf"
    return "ready", {"role": "assistant", "content": (
        f'<a class="sc-doc" href="/comprobante/{esc(a["id"])}" download="{esc(name)}">'
        f'<span class="sc-doc-ico" aria-hidden="true">PDF</span>'
        f'<span class="sc-doc-txt"><b>{esc(name)}</b><small>Comprobante de cita · {kb} KB · Toca para descargar</small></span></a>')}


def history_chat(token: str) -> tuple[list, dict]:
    hist = api.history(token, 40)
    chat = []
    for m in hist["messages"]:
        if m["direction"] == "inbound":
            chat.append(user_message(friendly(m["content"]), m.get("reply_to")))
        else:
            chat.append(bot_message(m.get("reply") or {"text": m["content"]}))
    # Comprobante vigente debajo de la ÚLTIMA confirmación de cada cita (consultado a la API, nunca supuesto)
    last: dict[str, int] = {}
    for i, c in enumerate(chat):
        mt = CONFIRMED_RE.search(c["content"]) if c["role"] == "assistant" else None
        if mt:
            last[mt.group(1)] = i
    if last:
        try:
            items = api.appointments(token)
        except ApiError:
            items = []
        for ref, i in sorted(last.items(), key=lambda kv: -kv[1]):
            status, doc = receipt_doc(token, ref, items)
            if doc:
                chat.insert(i + 1, doc)
    return chat, hist


def client_ip(request: gr.Request | None) -> str:
    try:
        from server import client_ip_from  # disponible cuando se ejecuta con server.py
        return client_ip_from(dict(request.headers), request.client.host if request and request.client else None)
    except Exception:
        return (request.client.host if request and request.client else "desconocida")[:64]


# ---------------------------------------------------------------------------
# Carga, acceso y recuperación (transparente: dentro del chat)
# ---------------------------------------------------------------------------

def on_load(request: gr.Request):
    """Carga la sesión del dispositivo (cookie HttpOnly creada por server.py), el perfil y la conversación persistente."""
    st = new_state()
    st["client_ip"] = client_ip(request)
    token = request.cookies.get(SESSION_COOKIE) if request else None
    if not token:
        return st, [{"role": "assistant", "content": "No se pudo iniciar la sesión. Recarga la página."}], "Sin sesión"
    st["token"] = token
    try:
        st["patient"] = api.me(token)
    except ApiError:
        return new_state(), [{"role": "assistant", "content": "Tu sesión caducó. Recarga la página para empezar de nuevo."}], "Sesión caducada"
    chat: list = []
    try:
        chat, hist = history_chat(token)
        last = next((m for m in reversed(hist["messages"]) if m["direction"] == "outbound"), None)
        if last and hist["state_step"] != "idle" and last.get("reply"):
            st["reply"] = last["reply"]
            st["proposal"] = last["reply"].get("proposal")
            st["confirm_key"] = str(uuid.uuid4()) if st["proposal"] else None
    except ApiError:
        pass
    if not chat:
        chat = [{"role": "assistant", "content": welcome_text()}]
    pending = server_pending_code(token)
    if pending:
        chat = chat + [code_bubble(pending, recovered=True)]
    return st, chat, who_line(st["patient"])


def server_pending_code(token: str) -> str | None:
    try:
        from server import pop_pending_code
        return pop_pending_code(token)
    except ImportError:
        return None


def code_bubble(code: str, recovered: bool = False, expires: str | None = None) -> dict:
    head = ("Listo, ya recuperaste tus citas en este dispositivo. 🔐 Tu código anterior dejó de valer; este es el nuevo:"
            if recovered else "🔐 Este es tu **código de recuperación**:")
    tail = (f" Vale hasta el {expires[:10]}." if expires else "")
    return {"role": "assistant", "content": f"{head}\n\n`{code}`\n\nGuárdalo en un lugar seguro: con él (y tu fecha de nacimiento) "
            f"puedes volver a tus citas desde otro teléfono. Solo te lo muestro esta vez.{tail}"}


def parse_birth(text: str) -> str | None:
    t = (text or "").strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d.%m.%Y", "%d %m %Y"):
        try:
            d = datetime.strptime(t, fmt).date()
            return d.isoformat() if date(1900, 1, 1) <= d <= date.today() else None
        except ValueError:
            continue
    return None


def recover_flow(text: str, st: dict, chat: list) -> tuple[list, str | None] | None:
    """Recuperación dentro del chat. Devuelve (chat, nonce) si el mensaje era parte del flujo; None si no."""
    m = CODE_RE.search(text or "")
    if m:
        st["recover_code"] = re.sub(r"[\s-]+", "", m.group(0)).upper()
        chat = chat + [{"role": "user", "content": "🔑 Código de recuperación ••••••"},
                       {"role": "assistant", "content": "Gracias. Para confirmar que eres tú, dime tu **fecha de nacimiento** "
                        "(por ejemplo 17/05/1990)."}]
        return chat, None
    if st.get("recover_code"):
        birth = parse_birth(text)
        if not birth:
            if re.search(r"\d", text or ""):
                return chat + [{"role": "user", "content": "📅 ••/••/••••"},
                               {"role": "assistant", "content": "No reconocí la fecha. Escríbela así: 17/05/1990."}], None
            st["recover_code"] = None
            return None
        code, st["recover_code"] = st["recover_code"], None
        chat = chat + [{"role": "user", "content": "📅 ••/••/••••"}]
        try:
            from server import recover_in_chat
            r = recover_in_chat(code, birth, st.get("client_ip") or "desconocida", st.get("token"))
        except ApiError as e:
            msg = ("Demasiados intentos desde esta red. Espera unos minutos y vuelve a probar."
                   if e.status == 429 else "No pude verificar el código con esa fecha de nacimiento. Revisa los datos e inténtalo de nuevo.")
            return chat + [{"role": "assistant", "content": msg}], None
        except ImportError:
            return chat + [{"role": "assistant", "content": "La recuperación no está disponible en este modo."}], None
        st.update(token=r["token"], patient=r["patient"], reply=None, proposal=None, reply_to=None)
        try:
            chat, _ = history_chat(r["token"])
        except ApiError:
            chat = []
        return chat + [code_bubble(r["new_recovery_code"], recovered=True, expires=r.get("new_recovery_code_expires_at"))], r["nonce"]
    if RECOVER_HINT_RE.search(text or ""):
        return chat + [{"role": "user", "content": text},
                       {"role": "assistant", "content": "Claro. Pega aquí tu **código de recuperación** (empieza por SCR-) y luego "
                        "te pediré tu fecha de nacimiento. Nunca lo compartas con nadie más."}], None
    return None


# ---------------------------------------------------------------------------
# Conversación
# ---------------------------------------------------------------------------

def send_text(text: str, st: dict, chat: list):
    """Mensaje de texto: burbuja propia, «escribiendo…» mientras n8n y el modelo trabajan, y la respuesta."""
    text = (text or "").strip()
    nonce = gr.update()
    if not text:
        yield (*view(st, chat), nonce)
        return
    try:
        require_login(st)
        handled = recover_flow(text, st, chat)
        if handled is not None:
            chat, n = handled
            yield (*view(st, chat, clear_input=True), n or gr.update())
            return
        rt = st.get("reply_to")
        chat = chat + [user_message(text, rt)]
        st["reply"], st["proposal"], st["reply_to"] = None, None, None
        yield (*view(st, chat + [TYPING], clear_input=True), nonce)
        sent = api.send_text(st["token"], text, rt)
        started = time.monotonic()
        while time.monotonic() - started < UI_TIMEOUT_SECONDS:
            time.sleep(POLL_SECONDS)
            u = api.get_update(st["token"], sent["update_id"])
            if u["status"] != "pending":
                st, chat = apply_reply(st, chat, u["reply"])
                yield (*view(st, chat), nonce)
                return
        # Tiempo agotado en la interfaz: se dice la verdad y se ofrece el menú, sin inventar respuesta
        st, chat = apply_reply(st, chat, {"mode": "fallback_menu", "menu": True,
                                          "text": "Estoy tardando más de lo normal en responder. Puedes esperar un momento y tocar "
                                                  "«Actualizar conversación», o usar las opciones de abajo."})
        yield (*view(st, chat), nonce)
    except ApiError as e:
        yield (*view(st, chat, f"⚠️ {e}"), nonce)


def select_message(st: dict, chat: list, evt: gr.SelectData):
    """Tocar un mensaje lo cita (responder tipo WhatsApp). La cita solo es contexto para el modelo."""
    idx = evt.index[0] if isinstance(evt.index, (list, tuple)) else evt.index
    try:
        msg = chat[int(idx)]
    except (IndexError, TypeError, ValueError):
        return (*view(st, chat),)
    content = msg.get("content") if isinstance(msg, dict) else None
    # Gradio 6 normaliza el contenido como lista de partes [{"type": "text", "text": ...}]
    if isinstance(content, list):
        content = " ".join(str(p.get("text", "")) if isinstance(p, dict) else str(p) for p in content)
    elif isinstance(content, dict):
        content = content.get("text") or ""
    text = plain(re.sub(r"^(>.*\n)+\n?", "", str(content or "")))
    if not text or "sc-typing" in str(content) or "•" in text or CODE_RE.search(str(content)):
        return (*view(st, chat),)
    st["reply_to"] = {"role": "user" if msg.get("role") == "user" else "assistant", "text": text}
    return (*view(st, chat),)


def cancel_quote(st: dict, chat: list):
    st["reply_to"] = None
    return (*view(st, chat),)


def send_action(action: dict, st: dict, chat: list, label: str | None = None):
    try:
        require_login(st)
        if label:
            chat = chat + [{"role": "user", "content": label}]
        r = api.send_action(st["token"], action)
        st, chat = apply_reply(st, chat, r["reply"])
        return view(st, chat, "")
    except ApiError as e:
        return view(st, chat, f"⚠️ {e}")


def pick_option(i: int, st: dict, chat: list):
    opts = (st.get("reply") or {}).get("options") or []
    if i >= len(opts):
        return view(st, chat, "Esa opción ya no está disponible.")
    return send_action({"type": "select_option", "index": opts[i]["index"]}, st, chat, f"Opción {opts[i]['index']}")


def pick_suggestion(i: int, st: dict, chat: list):
    suggs = (st.get("reply") or {}).get("suggestions") or []
    if i >= len(suggs):
        return view(st, chat, "Esa opción ya no está disponible.")
    return send_action(suggs[i]["action"], st, chat, suggs[i]["label"])


def pick_date(i: int, st: dict, chat: list):
    dates = (st.get("reply") or {}).get("date_choices") or []
    if i >= len(dates):
        return view(st, chat, "Esa fecha ya no está disponible.")
    return send_action({"type": "choose_date", "index": dates[i]["index"]}, st, chat, dates[i]["label"].capitalize())


def pick_specialty(i: int, st: dict, chat: list):
    specs = (st.get("reply") or {}).get("specialty_choices") or []
    if i >= len(specs):
        return view(st, chat, "Esa especialidad ya no está disponible.")
    return send_action({"type": "choose_specialty", "specialty_id": specs[i]["id"]}, st, chat, specs[i]["name"])


def more_specialties(st: dict, chat: list):
    # Solo muestra el resto de la lista ya recibida (sin ir a n8n); una respuesta nueva vuelve a la lista corta
    if st.get("reply"):
        st["reply"]["_specs_all"] = True
    return view(st, chat, "")


def pick_appointment(appointment_id: str | None, st: dict, chat: list):
    if not appointment_id:
        return view(st, chat, "Selecciona una cita de la lista.")
    return send_action({"type": "choose_appointment", "appointment_id": appointment_id}, st, chat, "Esta cita")


# --- Confirmación orquestada por n8n -------------------------------------------------------------------------
# La orden se guarda en el estado de la sesión (servidor) desde que se prepara: intención, token, clave de idempotencia
# y, cuando la API la registra, command_id y correlation_id. Así se puede volver a consultar o reenviar la MISMA orden
# (idempotente, sin crear otra reserva) aunque falle la red o venza la espera. «Sin cambios» solo se afirma ante un
# resultado terminal que lo garantiza: la API rechazó el envío (4xx) o la orden terminó «failed»/«expired».
CONFIRM_WAIT_SECONDS = 20.0
POLL_SECONDS = 0.3


def transient(e: ApiError) -> bool:
    """Errores que NO prueban nada sobre el resultado (red, servicio caído, límite de peticiones)."""
    return e.status >= 500 or e.status in (408, 429)


def no_changes(chat: list, st: dict, msg: str) -> list:
    st["reply"] = {"menu": True}
    return chat + [{"role": "assistant", "content": f"No se pudo completar: {sentence(msg)} No hubo cambios en tus citas."}]


UNCERTAIN = ("No pude verificar el resultado todavía. No hace falta que vuelvas a confirmar: lo sigo comprobando "
             "y te aviso aquí en cuanto lo sepa.")


def confirm(advance_opt_in: bool, full_name: str, birth_date, contact: str, st: dict, chat: list):
    """Confirmación explícita: prepara la intención (la API revalida todo) y envía la orden durable a n8n."""
    prop = st.get("proposal")
    if not prop:
        return view(st, chat, "No hay ninguna operación pendiente de confirmar.")
    if st.get("order"):
        return view(st, chat, "Ya hay una confirmación en curso; te aviso aquí del resultado.")
    try:
        require_login(st)
        first_booking = False
        if prop["kind"] == "booking" and not (st.get("patient") or {}).get("profile_complete"):
            # Perfil mínimo para reservar (sin registro previo): nombre, fecha de nacimiento y UN contacto
            # (teléfono o correo) para que el personal pueda localizar al paciente. Datos ficticios en la demo.
            birth = str(birth_date or "")[:10]
            if not (full_name or "").strip() or not parse_birth(birth) or not (contact or "").strip():
                return view(st, chat, "Escribe tu nombre, tu fecha de nacimiento y un teléfono o correo para reservar.")
            try:
                st["patient"] = api.update_profile(st["token"], full_name.strip(), birth, contact)
            except ApiError as e:
                if e.status == 400:   # dato no válido (p. ej., teléfono o correo): se corrige sin perder la propuesta
                    return view(st, chat, str(e))
                raise
            first_booking = (st.get("patient") or {}).get("kind") == "guest"
        body = {"kind": prop["kind"]}
        if prop["kind"] == "booking":
            body.update(slot_id=prop["slot_id"], advance_opt_in=bool(advance_opt_in))
        elif prop["kind"] == "cancellation":
            body.update(appointment_id=prop["appointment_id"], expected_version=prop["expected_version"], reason_code="patient_request")
        else:
            body.update(appointment_id=prop["appointment_id"], expected_version=prop["expected_version"], new_slot_id=prop["new_slot_id"])
        st["proposal"] = None  # evita dobles envíos desde esta sesión
        intent = api.prepare_intent(st["token"], body)      # preparar no modifica citas: un error aquí sí garantiza «sin cambios»
    except ApiError as e:
        st["proposal"] = None
        return view(st, no_changes(chat, st, str(e)), "")
    st["order"] = {"intent_id": intent["intent_id"], "intent_token": intent["token"], "kind": prop["kind"],
                   "key": st.get("confirm_key") or str(uuid.uuid4()), "first_booking": first_booking,
                   "command_id": None, "correlation_id": None}
    st["reply"] = None
    chat = chat + [{"role": "user", "content": "Confirmar"}]
    st, chat, settled = advance_order(st, chat, CONFIRM_WAIT_SECONDS)
    if not settled:
        chat = chat + [{"role": "assistant", "content": settled_message(st)}]
    return view(st, chat, "")


def settled_message(st: dict) -> str:
    o = st.get("order") or {}
    if o.get("last") == "queued":
        return ("Tu confirmación está en cola en el orquestador (n8n). Todavía no se ha aplicado; te avisaré aquí del resultado. "
                f"Referencia de seguimiento: `{(o.get('correlation_id') or '')[:8]}`.")
    if o.get("last") == "running":
        return "n8n está procesando tu confirmación. Te aviso aquí del resultado en cuanto termine."
    return UNCERTAIN


def advance_order(st: dict, chat: list, wait_seconds: float) -> tuple[dict, list, bool]:
    """Hace avanzar la orden guardada: la registra (o reenvía la MISMA, idempotente) y consulta su estado.
    Devuelve settled=True si llegó a un resultado terminal (y lo deja en el chat)."""
    o = st["order"]
    if not o.get("command_id"):
        try:
            r = api.submit_intent(st["token"], o["intent_id"], o["intent_token"], o["key"])
            o.update(command_id=r["command_id"], correlation_id=r["correlation_id"], last="queued")
        except ApiError as e:
            if transient(e):
                o["last"] = "unknown"
                return st, chat, False
            st["order"] = None                                # la API rechazó el envío: no hay orden
            return st, no_changes(chat, st, str(e)), True
    end = time.monotonic() + wait_seconds
    while True:
        try:
            res = api.confirmation_status(st["token"], o["intent_id"])
        except ApiError:
            o["last"] = "unknown"                             # no prueba nada: se sigue consultando
            return st, chat, False
        o["last"] = res["status"]
        if res["status"] not in ("queued", "running"):
            st, chat = finish_confirmation(st, chat, res)
            return st, chat, True
        if time.monotonic() >= end:
            return st, chat, False
        time.sleep(POLL_SECONDS)


def verified_text(res: dict) -> str:
    """Mensaje a partir del resultado VERIFICADO de la API (si falla la redacción habitual del chat)."""
    r = res.get("result") or {}
    ap = r.get("appointment") or {}
    slot = ap.get("slot") or {}
    ref, label, doctor = ap.get("booking_reference", ""), slot.get("label", ""), (slot.get("doctor") or {}).get("display_name", "")
    if r.get("outcome") == "booked":
        return sentence(f"Listo: tu cita {ref} con {doctor} quedó confirmada para el {label}")
    if r.get("outcome") == "rescheduled":
        return sentence(f"Listo: tu cita {ref} ahora es el {label} con {doctor}")
    if r.get("outcome") == "cancelled":
        return sentence(f"Listo: la cita {ref} del {label} quedó cancelada")
    return f"La cita {ref} ya estaba cancelada."


def finish_confirmation(st: dict, chat: list, res: dict) -> tuple[dict, list]:
    """Resultado terminal de la orden ejecutada por n8n → mensaje, comprobante PDF y (primera reserva) código."""
    o = st.get("order") or {}
    st["order"] = None
    if res["status"] != "confirmed":
        msg = (res.get("error") or {}).get("message") or "No se pudo completar la operación."
        return st, no_changes(chat, st, msg)
    # Confirmada y verificada: se muestra SIEMPRE, aunque falle la redacción habitual del chat
    try:
        r = api.send_action(st["token"], {"type": "intent_result", "intent_id": o.get("intent_id") or res.get("intent_id")})
        st, chat = apply_reply(st, chat, r["reply"])
        text = (r["reply"] or {}).get("text", "")
    except ApiError:
        text = verified_text(res)
        st["reply"] = {"menu": True}
        chat = chat + [bot_message({"text": text})]
    chat = deliver_receipt(st, chat, text)
    if o.get("first_booking") and (res.get("result") or {}).get("outcome") == "booked":
        st["recovery_due"] = True
    return st, deliver_recovery(st, chat)


def deliver_recovery(st: dict, chat: list) -> list:
    """Primera reserva confirmada de un visitante: entrega su código de recuperación UNA vez.
    El código solo vive en esta burbuja (no va al modelo, a n8n, a los logs ni al historial guardado)."""
    if not st.get("recovery_due"):
        return chat
    st["recovery_due"] = False                               # nunca se reintenta solo: evita rotar o duplicar códigos
    try:
        if api.recovery_status(st["token"])["active"]:
            return chat                                      # ya tiene un código vigente: no se sustituye sin pedirlo
        c = api.rotate_recovery_code(st["token"])
        return chat + [code_bubble(c["recovery_code"], expires=c["expires_at"])]
    except ApiError:
        return chat + [{"role": "assistant", "content": "Tu cita está confirmada, pero no pude entregarte tu **código de recuperación** ahora. "
                        "Puedes generarlo cuando quieras desde el menú ⋮ → «Ver mi código de recuperación» (anula cualquier código anterior)."}]


def watch_confirmation(st: dict, chat: list):
    """Temporizador: sigue la orden guardada hasta un resultado terminal (sin crear otra reserva)."""
    if not (st or {}).get("order") or not st.get("token"):
        return gr.skip(), gr.skip()
    before = (st["order"] or {}).get("last")
    st, chat2, settled = advance_order(st, chat, 0)
    if settled:
        return st, chat2
    if before == "unknown" and st["order"].get("last") in ("queued", "running"):
        return st, chat2 + [{"role": "assistant", "content": settled_message(st)}]   # ya se sabe que está registrada
    return st, gr.skip()


def deliver_receipt(st: dict, chat: list, text: str) -> list:
    """Tras confirmar: n8n genera el PDF (≈0,5 s). Se espera un momento; si aún no está, el temporizador lo entrega."""
    mt = CONFIRMED_RE.search(text or "")
    if not mt:
        return chat
    ref = mt.group(1)
    for _ in range(8):
        status, doc = receipt_doc(st["token"], ref)
        if doc:
            return chat + [doc]
        if status in ("failed", "none"):
            break
        time.sleep(0.5)
    if status == "failed":
        return chat + [{"role": "assistant", "content": "No se pudo generar el comprobante PDF. Tu cita sigue confirmada; "
                        "puedes reintentarlo desde **Mis citas**."}]
    st["receipt_watch"] = ref
    return chat + [{"role": "assistant", "content": "Tu cita está confirmada. El comprobante PDF aún se está generando; "
                    "lo verás aquí y en **Mis citas** en cuanto esté listo."}]


def watch_receipt(st: dict, chat: list):
    """Temporizador: entrega el comprobante pendiente en el chat. Sin cambios → no toca el chat."""
    ref = (st or {}).get("receipt_watch")
    if not ref or not st.get("token"):
        return gr.skip(), gr.skip()
    status, doc = receipt_doc(st["token"], ref)
    if doc:
        st["receipt_watch"] = None
        return st, chat + [doc]
    if status in ("failed", "none"):
        st["receipt_watch"] = None
        if status == "failed":
            return st, chat + [{"role": "assistant", "content": "No se pudo generar el comprobante PDF. Tu cita sigue confirmada; "
                                "puedes reintentarlo desde **Mis citas**."}]
        return st, gr.skip()
    return gr.skip(), gr.skip()


def discard(st: dict, chat: list):
    st["proposal"] = None
    return send_action({"type": "discard_proposal"}, st, chat, "Descartar")


def refresh_history(st: dict, chat: list):
    try:
        require_login(st)
        chat, hist = history_chat(st["token"])
        last = next((m for m in reversed(hist["messages"]) if m["direction"] == "outbound"), None)
        st, _ = apply_reply(st, [], last["reply"] if last and hist["state_step"] != "idle" else None)
        return view(st, chat or [{"role": "assistant", "content": welcome_text()}], "")
    except ApiError as e:
        return view(st, chat, f"⚠️ {e}")


# --- Menú ⋮ ---

def menu_show_code(st: dict, chat: list):
    try:
        require_login(st)
        c = api.rotate_recovery_code(st["token"])
        bubble = code_bubble(c["recovery_code"], expires=c["expires_at"])
        bubble["content"] += " Si tenías otro código, ya no vale."
        chat = chat + [bubble]
    except ApiError as e:
        chat = chat + [{"role": "assistant", "content": f"No pude generar el código: {e}"}]
    return view(st, chat)


def menu_recover(st: dict, chat: list):
    chat = chat + [{"role": "assistant", "content": "Para recuperar tus citas de otro dispositivo, pega aquí tu **código de recuperación** "
                    "(empieza por SCR-). Después te pediré tu fecha de nacimiento."}]
    return view(st, chat)


def menu_revoke_others(st: dict, chat: list):
    try:
        n = api.revoke_other_sessions(st["token"])["revoked_sessions"]
        msg = f"Listo: cerré {n} sesión(es) en otros dispositivos." if n else "No había sesiones abiertas en otros dispositivos."
    except ApiError as e:
        msg = f"No se pudo: {e}"
    return view(st, chat + [{"role": "assistant", "content": mark_refs(msg)}])


MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
STATUS = {"booked": ("Confirmada", "ok"), "cancelled": ("Cancelada", "off"), "completed": ("Atendida", "done"),
          "no_show": ("No asistió", "off")}


def _day_tile(starts_at: str | None) -> str:
    try:
        d = datetime.fromisoformat(starts_at)
        return f'<div class="sc-tile" aria-hidden="true"><b>{d.day}</b><span>{MONTHS[d.month - 1]}</span></div>'
    except (TypeError, ValueError):
        return '<div class="sc-tile" aria-hidden="true"><span class="sc-ico sc-sched-ico"></span></div>'


def receipt_line(st: dict, a: dict) -> str:
    """Estado REAL del comprobante de la versión vigente (lo genera n8n tras confirmar)."""
    if a["status"] != "booked":
        return ""
    try:
        r = api.receipt_status(st["token"], a["id"])
    except ApiError:
        return ""
    if r.get("status") == "ready":
        return (f'<a class="sc-receipt" href="/comprobante/{esc(a["id"])}" download>'
                f'<span class="sc-ico" style="--i:var(--i-doc)"></span>Descargar comprobante n.º {r.get("receipt_number")} (PDF)</a>')
    if r.get("status") == "failed":
        return (f'<button type="button" class="sc-receipt sc-receipt-retry" data-sc-cmd="receipt-retry:{esc(a["id"])}">'
                '<span class="sc-ico" style="--i:var(--i-restore)"></span>No se pudo generar el comprobante · Reintentar</button>')
    if r.get("status") == "pending":
        return '<span class="sc-receipt sc-receipt-pending" role="status">Generando comprobante…</span>'
    return ""


def render_appointments(st: dict) -> str:
    """Mis citas como tarjetas: las vigentes primero; las canceladas atenuadas al final."""
    if not st.get("token"):
        return ""
    try:
        items = api.appointments(st["token"])
    except ApiError as e:
        return f'<div class="sc-empty">No se pudieron cargar tus citas: {esc(str(e))}</div>'
    if not items:
        return ('<div class="sc-empty"><span class="sc-ico sc-sched-ico"></span>'
                "<p><b>No tienes citas próximas.</b></p><p>Pídele una al asistente en la pestaña Chat.</p></div>")
    items = sorted(items, key=lambda a: (a["status"] != "booked", a["slot"].get("starts_at") or ""))
    cards = []
    for a in items:
        s = a["slot"]
        label, tone = STATUS.get(a["status"], (a["status"], "off"))
        when = s["label"].split(", ", 1)[-1] if ", " in s["label"] else s["label"]
        cards.append(
            f'<li class="sc-appt sc-{tone}">{_day_tile(s.get("starts_at"))}<div class="sc-appt-body">'
            f'<div class="sc-appt-top"><b>{esc(s["specialty"]["name"])}</b><span class="sc-pill sc-pill-{tone}">{label}</span></div>'
            f'<div class="sc-appt-line"><span class="sc-ico" style="--i:var(--i-user)"></span>{esc(s["doctor"]["display_name"])}</div>'
            f'<div class="sc-appt-line"><span class="sc-ico" style="--i:var(--i-clock)"></span>{esc(s["label"])}</div>'
            f'<div class="sc-appt-ref">Referencia <code>{esc(a["booking_reference"])}</code></div>{receipt_line(st, a)}</div></li>')
    active = [c for c, a in zip(cards, items) if a["status"] == "booked"]
    other = [c for c, a in zip(cards, items) if a["status"] != "booked"]
    html_ = f'<ul class="sc-list" aria-label="Citas vigentes">{"".join(active)}</ul>' if active else (
        '<div class="sc-empty"><p><b>No tienes citas vigentes.</b></p></div>')
    if other:
        html_ += (f'<details class="sc-more"><summary>Canceladas y anteriores ({len(other)})</summary>'
                  f'<ul class="sc-list" aria-label="Citas canceladas y anteriores">{"".join(other)}</ul></details>')
    return html_


NOTIF_ICON = {"booking_confirmed": ("cal", "ok"), "appointment_cancelled": ("cancel", "off"), "appointment_rescheduled": ("swap", "info"),
              "reminder_24h": ("clock", "info"), "reminder_1h": ("clock", "info"), "advance_offer": ("bolt", "accent"),
              "advance_accepted": ("cal", "ok"), "offer_expired": ("clock", "off"), "handoff_update": ("chat", "info")}


def _when(ts: str | None) -> str:
    try:
        d = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return ""
    today = datetime.now(d.tzinfo).date()
    hm = d.strftime("%H:%M")
    if d.date() == today:
        return hm
    return f"{d.day} {MONTHS[d.month - 1]} · {hm}"


NOTIF_PAGE = 10


def render_notifications(st: dict) -> tuple[str, str]:
    """Avisos tipo chat: filtros, páginas de 10 con «Mostrar más», tocar = leído y ✕ = quitar (archivar)."""
    if not st.get("token"):
        return "", ""
    limit = int(st.get("notif_limit") or NOTIF_PAGE)
    unread_only = st.get("notif_filter") == "unread"
    try:
        data = api.notifications(st["token"], limit=min(limit, 100), unread_only=unread_only)
    except ApiError as e:
        return f'<div class="sc-empty">No se pudieron cargar los avisos: {esc(str(e))}</div>', ""
    badge = str(data["unread"]) if data["unread"] else ""
    total = data.get("total", len(data["items"]))
    chips = (f'<div class="sc-chips" role="group" aria-label="Filtrar avisos">'
             f'<button type="button" class="sc-chip{" on" if not unread_only else ""}" data-sc-cmd="filter:all" aria-pressed="{str(not unread_only).lower()}">Todos</button>'
             f'<button type="button" class="sc-chip{" on" if unread_only else ""}" data-sc-cmd="filter:unread" aria-pressed="{str(unread_only).lower()}">'
             f'No leídos{f" <b>{data["unread"]}</b>" if data["unread"] else ""}</button>'
             + ('<button type="button" class="sc-chip sc-chip-link" data-sc-cmd="readall">Marcar todo como leído</button>' if data["unread"] else "")
             + "</div>")
    if not data["items"]:
        empty = ("No tienes avisos sin leer." if unread_only else "No tienes avisos.")
        return (chips + f'<div class="sc-empty"><span class="sc-ico" style="--i:var(--i-bell)"></span><p><b>{empty}</b></p>'
                "<p>Aquí verás confirmaciones, recordatorios y horarios que se liberen antes.</p></div>"), badge
    rows = []
    for n in data["items"]:
        icon, tone = NOTIF_ICON.get(n["kind"], ("bell", "info"))
        unread = not n["read_at"]
        dot = '<span class="sc-dot" aria-label="No leído"></span>' if unread else ""
        rows.append(
            f'<li class="sc-notif{" sc-unread" if unread else ""}" data-sc-cmd="read:{n["id"]}" tabindex="0" '
            f'aria-label="{esc(n["title"])}{", no leído" if unread else ""}"><span class="sc-notif-ic sc-tone-{tone}">'
            f'<span class="sc-ico" style="--i:var(--i-{icon})"></span></span><div class="sc-notif-body">'
            f'<div class="sc-notif-top"><b>{esc(n["title"])}</b><time>{_when(n["sent_at"])}</time></div>'
            f'<p>{esc(n["body"])}</p></div>{dot}'
            f'<button type="button" class="sc-x" data-sc-cmd="archive:{n["id"]}" aria-label="Quitar aviso «{esc(n["title"])}»" title="Quitar">'
            f'<span class="sc-ico" style="--i:var(--i-close)"></span></button></li>')
    more = ""
    if total > len(data["items"]):
        more = (f'<button type="button" class="sc-more-btn" data-sc-cmd="more">Mostrar más '
                f'<span>({total - len(data["items"])})</span></button>')
    note = ('<p class="sc-list-note">Toca un aviso para marcarlo como leído; ✕ lo quita de la bandeja. '
            "Los avisos solo se muestran aquí (sin SMS, correos ni notificaciones al teléfono).</p>")
    return f'{chips}<ul class="sc-list" aria-label="Avisos">{"".join(rows)}</ul>{more}{note}', badge


def notif_command(cmd: str, st: dict):
    """Acciones de la bandeja enviadas desde el HTML (puente oculto): filtro, más, leído, quitar, todo leído."""
    cmd = (cmd or "").strip()
    try:
        if cmd == "more":
            st["notif_limit"] = int(st.get("notif_limit") or NOTIF_PAGE) + NOTIF_PAGE
        elif cmd.startswith("filter:"):
            st["notif_filter"] = "unread" if cmd.endswith("unread") else "all"
            st["notif_limit"] = NOTIF_PAGE
        elif cmd == "readall":
            api.read_all(st["token"])
        elif cmd.startswith("read:") and re.fullmatch(r"read:[0-9a-f-]{36}", cmd):
            api.mark_read(st["token"], cmd[5:])
        elif cmd.startswith("archive:") and re.fullmatch(r"archive:[0-9a-f-]{36}", cmd):
            api.archive_notification(st["token"], cmd[8:])
        elif cmd.startswith("receipt-retry:") and re.fullmatch(r"receipt-retry:[0-9a-f-]{36}", cmd):
            api.retry_receipt(st["token"], cmd[14:])
    except ApiError:
        pass
    html_, badge = render_notifications(st)
    return st, html_, badge, render_appointments(st), ""


MAX_OFFERS = 2


def render_offers(st: dict):
    """Ofertas pendientes como tarjetas con Aceptar/Rechazar (máximo 2). Sin ofertas, no ocupan espacio."""
    pending = []
    if st.get("token"):
        try:
            pending = [o for o in api.offers(st["token"]) if o["status"] == "pending"][:MAX_OFFERS]
        except ApiError:
            pending = []
    st["offers"] = pending
    out = []
    for i in range(MAX_OFFERS):
        o = pending[i] if i < len(pending) else None
        text = (f"**Horario disponible antes:** {o['offered_slot']['label']} con {o['offered_slot']['doctor']}  \n"
                f"Tu cita {o['appointment']['booking_reference']} es el {sentence(o['appointment']['current_label'])} "
                f"Responde antes de las {o['expires_at'][11:16]}{' (modo demostración)' if o['demo_mode'] else ''}. "
                "Si no aceptas, tu cita se mantiene.") if o else ""
        out += [gr.update(visible=bool(o)), gr.update(visible=bool(o), value=text), gr.update(visible=bool(o)), gr.update(visible=bool(o))]
    return (st, *out)


def answer_offer(i: int, action: str, st: dict):
    offers = st.get("offers") or []
    msg = ""
    if i < len(offers):
        o = offers[i]
        try:
            # n8n orquesta la respuesta: la API registra la orden, n8n la reclama y la API mueve (o no) la cita
            api.answer_offer(st["token"], o["id"], action, str(uuid.uuid4()))
            end = time.monotonic() + CONFIRM_WAIT_SECONDS
            try:
                res = api.offer_answer_status(st["token"], o["id"])
                while res["status"] in ("queued", "running") and time.monotonic() < end:
                    time.sleep(POLL_SECONDS)
                    res = api.offer_answer_status(st["token"], o["id"])
            except ApiError:
                res = {"status": "unknown"}                  # no prueba nada: no se afirma éxito ni fracaso
            if res["status"] == "unknown":
                msg = "No pude verificar el resultado todavía. Revisa **Mis citas** en unos segundos; no hace falta responder de nuevo."
            elif res["status"] == "done":
                msg = sentence("✅ Cita adelantada al " + o["offered_slot"]["label"]) if action == "accept" else "Oferta rechazada. Tu cita se mantiene."
            elif res["status"] in ("queued", "running"):
                msg = "Tu respuesta está en cola en el orquestador (n8n). Aún no hay cambios; revisa Mis citas en unos segundos."
            else:
                msg = f"⚠️ {sentence((res.get('error') or {}).get('message') or 'No se pudo completar.')} Tu cita original se mantiene."
        except ApiError as e:
            msg = f"⚠️ {e}"
    st2, *updates = render_offers(st)
    notif, badge = render_notifications(st2)
    return (st2, *updates, msg, notif, badge, render_appointments(st2))


def mark_all_read(st: dict):
    if st.get("token"):
        try:
            api.read_all(st["token"])
        except ApiError:
            pass
    return render_notifications(st)


# ---------------------------------------------------------------------------
# Interfaz
# ---------------------------------------------------------------------------

_SYSTEM_FONT = ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"]
THEME = gr.themes.Soft(
    primary_hue=gr.themes.Color(c50="#f4f0ff", c100="#ece6fd", c200="#d9cdfc", c300="#bba6fa", c400="#9b80ff",
                                c500="#7c5cfa", c600="#5b34d6", c700="#4a27b8", c800="#3a1f8f", c900="#2c186b", c950="#1c1047"),
    secondary_hue="slate", neutral_hue="slate",
    font=_SYSTEM_FONT, font_mono=["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],  # sin fuentes externas
).set(button_primary_background_fill="#5b34d6", button_primary_background_fill_hover="#4a27b8",
      button_primary_text_color="#ffffff")

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
ROBOT_SVG = os.path.join(ASSETS, "robot.svg")
with open(ROBOT_SVG, encoding="utf-8") as _f:
    ROBOT_INLINE = _f.read()


def _icon(path: str) -> str:
    """Icono SVG (trazo) como data URI para usar con mask-image; color por currentColor."""
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' "
           f"stroke-linecap='round' stroke-linejoin='round'>{path}</svg>")
    return f'url("data:image/svg+xml;utf8,{svg}")'


_ICONS = {
    "sound": "<path d='M11 5 6 9H3v6h3l5 4V5z'/><path d='M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13'/>",
    "mute": "<path d='M11 5 6 9H3v6h3l5 4V5z'/><path d='m22 9-6 6M16 9l6 6'/>",
    "kebab": "<circle cx='12' cy='5' r='1.2' fill='black'/><circle cx='12' cy='12' r='1.2' fill='black'/><circle cx='12' cy='19' r='1.2' fill='black'/>",
    "send": "<path d='M3.4 20.4 21 12 3.4 3.6l.01 6.53L15.5 12 3.41 13.87z' fill='black' stroke='none'/>",
    "close": "<path d='M6 6l12 12M18 6 6 18'/>",
    "cal": "<rect x='3' y='5' width='18' height='16' rx='2'/><path d='M16 3v4M8 3v4M3 10h18'/><path d='m9 15 2 2 4-4'/>",
    "cancel": "<rect x='3' y='5' width='18' height='16' rx='2'/><path d='M16 3v4M8 3v4M3 10h18'/><path d='m10 14 4 4M14 14l-4 4'/>",
    "swap": "<path d='M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7'/>",
    "user": "<circle cx='12' cy='8' r='4'/><path d='M4 21a8 8 0 0 1 16 0'/>",
    "clock": "<circle cx='12' cy='12' r='9'/><path d='M12 7v5l3 2'/>",
    "info": "<circle cx='12' cy='12' r='9'/><path d='M12 11v5M12 8h.01'/>",
    "key": "<circle cx='7.5' cy='15.5' r='4.5'/><path d='m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2'/>",
    "devices": "<rect x='2' y='4' width='14' height='10' rx='2'/><path d='M6 18h6M9 14v4'/><rect x='17' y='8' width='5' height='12' rx='1'/>",
    "logout": "<path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'/>",
    "restore": "<path d='M3 12a9 9 0 1 0 3-6.7L3 8'/><path d='M3 3v5h5'/><path d='M12 7v5l3 2'/>",
    "flask": "<path d='M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.8-2.5L14 9V3'/><path d='M7 15h10'/>",
    "doc": "<path d='M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z'/><path d='M14 3v6h6M9 14h6M9 17h4'/>",
    "bell": "<path d='M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'/><path d='M10.3 21a1.94 1.94 0 0 0 3.4 0'/>",
    "bolt": "<path d='M13 2 3 14h9l-1 8 10-12h-9l1-8z'/>",
    "chat": "<path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/>",
}
ICON_VARS = ":root{" + "".join(f"--i-{k}:{_icon(v)};" for k, v in _ICONS.items()) + "}"

_PATTERN = ("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'>"
            "<g fill='none' stroke='%23c9bdea' stroke-width='2' stroke-linecap='round' opacity='.5'>"
            "<path d='M20 14v14M13 21h14'/><rect x='72' y='12' width='26' height='22' rx='4'/><path d='M72 20h26M79 9v6M91 9v6'/>"
            "<path d='M28 86c-8-6-12-10-12-15a6 6 0 0 1 12-2 6 6 0 0 1 12 2c0 5-4 9-12 15z'/>"
            "<circle cx='88' cy='84' r='10'/><path d='M88 78v6l4 3'/><path d='M52 52h16M60 44v16'/></g></svg>")

with open(os.path.join(ASSETS, "wa.css"), encoding="utf-8") as _f:
    CSS = (ICON_VARS + f":root{{--wa-pattern-img:url(\"{_PATTERN}\");}} .dark{{--wa-pattern-img:none;}}\n" + _f.read())
with open(os.path.join(ASSETS, "wa.js"), encoding="utf-8") as _f:
    HEAD = f"<script>\n{_f.read()}\n</script>"
ACCESS_JS = HEAD  # compatibilidad con server.py

WA_HEADER = f"""<div class="sc-wa-head"><div class="sc-wa-avatar" aria-hidden="true">{ROBOT_INLINE}</div>
<div class="sc-wa-title"><p class="sc-wa-name">Salu · SaludCita</p></div>
<button type="button" class="sc-wa-iconbtn sc-wa-sound" aria-pressed="true" aria-label="Silenciar sonidos">
<span class="sc-ico on" style="--i:var(--i-sound)"></span><span class="sc-ico off" style="--i:var(--i-mute)"></span></button>
<button type="button" class="sc-wa-iconbtn sc-wa-kebab-btn" aria-haspopup="true" aria-expanded="false" aria-label="Más opciones">
<span class="sc-ico" style="--i:var(--i-kebab)"></span></button></div>"""

with gr.Blocks(title="SaludCita AI") as demo:
    st = gr.State(new_state())
    nonce_box = gr.Textbox(visible=False)

    with gr.Column(elem_classes="sc-wa") as app_col:
        gr.HTML(WA_HEADER)
        with gr.Row(equal_height=True, elem_classes="sc-wa-meta"):
            who = gr.Markdown(min_width=160)
            badge = gr.Markdown(min_width=0, elem_classes="sc-badge-src")
        # Menú ⋮ (opciones de cuenta; el acceso normal es transparente)
        with gr.Column(elem_classes="sc-wa-kebab", elem_id="sc-kebab"):
            gr.HTML('<p class="sc-kebab-title">Sonido</p><button type="button" class="sc-kebab-toggle sc-keysound" aria-pressed="false">'
                    '<span>Sonido al teclear</span><span class="sc-switch" aria-hidden="true"></span></button>'
                    '<p class="sc-kebab-title">Tu acceso</p>')
            btn_code = gr.Button("Ver mi código de recuperación", size="sm", elem_classes="sc-mi sc-mi-key")
            btn_recover_hint = gr.Button("Recuperar citas de otro dispositivo", size="sm", elem_classes="sc-mi sc-mi-restore")
            btn_others = gr.Button("Cerrar sesión en otros dispositivos", size="sm", elem_classes="sc-mi sc-mi-devices")
            with gr.Accordion("Cuenta de demostración", open=False, elem_classes="sc-mi-acc"):
                demo_user = gr.Textbox(label="Usuario", max_lines=1, placeholder="paciente01")
                demo_pass = gr.Textbox(label="Contraseña", type="password", max_lines=1)
                btn_demo = gr.Button("Entrar", size="sm", elem_classes="sc-primary")
            btn_logout = gr.Button("Cerrar sesión en este dispositivo", size="sm", elem_classes="sc-mi sc-mi-logout sc-danger")

        with gr.Tabs(elem_classes="sc-wa-tabs", overflow_behavior="wrap", elem_id="sc-tabs"):
            with gr.Tab("Chat", elem_classes="sc-wa-chat-tab"):
                chatbot = gr.Chatbot(show_label=False, height=500, layout="bubble", sanitize_html=True,
                                     render_markdown=True, line_breaks=True, buttons=[], elem_classes="sc-wa-chat",
                                     avatar_images=(None, ROBOT_SVG), placeholder="", autoscroll=True,
                                     group_consecutive_messages=False, elem_id="sc-chat")
                with gr.Column(elem_classes="sc-wa-actions"):
                    status = gr.Markdown(elem_classes="sc-status")
                    with gr.Column(elem_classes="sc-choice"):
                        sugg_btns = [gr.Button(visible=False, variant="secondary") for _ in range(MAX_SUGGESTIONS)]
                        opt_btns = [gr.Button(visible=False, variant="secondary") for _ in range(MAX_OPTIONS)]
                        btn_more = gr.Button("Ver más horarios", visible=False, size="sm")
                        btn_other_spec = gr.Button("Elegir otra especialidad", visible=False, size="sm", elem_classes="sc-back")
                        date_btns = [gr.Button(visible=False, variant="secondary") for _ in range(2)]
                        spec_btns = [gr.Button(visible=False, variant="secondary") for _ in range(MAX_SPECIALTIES)]
                        btn_more_specs = gr.Button("Ver más especialidades", visible=False, size="sm")
                        appt_choice = gr.Radio(label="Elige la cita", visible=False)
                        btn_appt = gr.Button("Continuar con esta cita", visible=False)
                    with gr.Column(visible=False, elem_classes="sc-wa-card", elem_id="sc-card") as proposal_box:
                        proposal_md = gr.HTML()
                        advance_cb = gr.Checkbox(label="Avisarme si se libera un horario antes con el mismo médico",
                                                 visible=False, elem_classes="sc-card-switch")
                        with gr.Column(visible=False, elem_classes="sc-card-fields") as profile_row:
                            prof_name = gr.Textbox(label="Tu nombre y apellido", placeholder="Como quieres que te llamemos",
                                                   max_lines=1, max_length=160)
                            # Selector de fecha NATIVO del navegador (wa.js convierte el campo en <input type="date">):
                            # el emergente de gr.DateTime quedaba recortado por la tarjeta y no se abría.
                            prof_birth = gr.Textbox(label="Fecha de nacimiento", max_lines=1,
                                                    max_length=10, elem_id="sc-birth")
                            prof_contact = gr.Textbox(label="Teléfono o correo", placeholder="(809) 555-0123 o nombre@correo.com",
                                                      max_lines=1, max_length=120, elem_id="sc-contact",
                                                      info="Para avisarte si cambia algo de tu cita. Solo uno de los dos.")
                        with gr.Column(elem_classes="sc-card-actions"):
                            btn_confirm = gr.Button("Confirmar", variant="primary", elem_classes="sc-primary")
                            btn_discard = gr.Button("Descartar", variant="secondary", elem_classes="sc-secondary")
                    with gr.Row(elem_classes="sc-menu"):
                        menu_btns = [(gr.Button(lbl, size="sm"), item, lbl) for lbl, item in MENU]
                with gr.Row(visible=False, elem_classes="sc-wa-quote", elem_id="sc-quote") as quote_row:
                    quote_md = gr.HTML()
                    btn_quote_x = gr.Button("Cancelar respuesta", elem_classes="sc-quote-close", scale=0, min_width=44)
                with gr.Row(equal_height=False, elem_classes="sc-wa-input"):
                    txt = gr.Textbox(show_label=False, placeholder="Escribe un mensaje", max_lines=4, scale=5,
                                     max_length=1000, autofocus=True, container=False, elem_classes="sc-wa-text", elem_id="sc-input")
                    btn_send = gr.Button("Enviar", variant="primary", scale=0, min_width=48, elem_classes="sc-wa-send", elem_id="sc-send")
                btn_refresh_chat = gr.Button("Actualizar conversación", size="sm", variant="secondary", elem_classes="sc-wa-refresh")
            with gr.Tab("Mis citas", elem_classes="sc-wa-panel") as tab_appts:
                appts_md = gr.HTML()
                btn_refresh_appts = gr.Button("Actualizar", size="sm", elem_classes="sc-link")
            with gr.Tab("Avisos", elem_classes="sc-wa-panel") as tab_notif:
                offer_widgets = []
                for _ in range(MAX_OFFERS):
                    with gr.Column(visible=False, elem_classes="sc-offer") as ocol:
                        md = gr.Markdown(visible=False)
                        with gr.Row():
                            acc = gr.Button("Aceptar adelanto", variant="primary", visible=False, size="sm", elem_classes="sc-primary")
                            rej = gr.Button("Rechazar", visible=False, size="sm", elem_classes="sc-secondary")
                    offer_widgets.append((ocol, md, acc, rej))
                offer_msg = gr.Markdown(elem_classes="sc-status")
                notif_md = gr.HTML()
                with gr.Row(visible=False):
                    btn_refresh_notif = gr.Button("Actualizar", size="sm", elem_classes="sc-link")
                    btn_read_all = gr.Button("Marcar todo como leído", size="sm", elem_classes="sc-link")
        # Puente oculto: el HTML de Avisos y Mis citas envía aquí sus órdenes (filtro, más, leído, quitar, reintentar comprobante)
        notif_cmd = gr.Textbox(elem_id="sc-bridge", elem_classes="sc-bridge", show_label=False, container=False)
        btn_notif_cmd = gr.Button("bridge", elem_id="sc-bridge-btn", elem_classes="sc-bridge")
        gr.Markdown(elem_classes="sc-wa-foot", value="<sub>Prototipo académico (UASD, G6) con datos ficticios. Solo gestión administrativa "
                    "de citas: no diagnostica ni hace triaje. En una urgencia, acude a emergencias o llama al 9-1-1.</sub>")

    OUT = [st, chatbot, status, *sugg_btns, *opt_btns, btn_more, btn_other_spec, *date_btns, *spec_btns, btn_more_specs, appt_choice, btn_appt,
           proposal_box, proposal_md, advance_cb, profile_row, quote_row, quote_md, txt]

    demo.load(on_load, None, [st, chatbot, who]).then(
        lambda s, c: view(s, c, ""), [st, chatbot], OUT).then(
        lambda s: (render_appointments(s), *render_notifications(s)), st, [appts_md, notif_md, badge])

    # Texto libre: n8n + modelo local; la recuperación por código se resuelve aquí sin enviarla a la conversación
    for trigger in (btn_send.click, txt.submit):
        trigger(send_text, [txt, st, chatbot], OUT + [nonce_box]).then(
            None, nonce_box, None, js="(n) => window.scActivate(n)").then(
            lambda s: who_line(s.get("patient")), st, who)
    chatbot.select(select_message, [st, chatbot], OUT)
    btn_quote_x.click(cancel_quote, [st, chatbot], OUT)
    for i, b in enumerate(sugg_btns):
        b.click(partial(pick_suggestion, i), [st, chatbot], OUT)
    for i, b in enumerate(opt_btns):
        b.click(partial(pick_option, i), [st, chatbot], OUT)
    btn_more.click(lambda s, c: send_action({"type": "more_options"}, s, c, "Ver más horarios"), [st, chatbot], OUT)
    btn_other_spec.click(lambda s, c: send_action({"type": "menu", "item": "book"}, s, c, "Elegir otra especialidad"), [st, chatbot], OUT)
    for i, b in enumerate(date_btns):
        b.click(partial(pick_date, i), [st, chatbot], OUT)
    for i, b in enumerate(spec_btns):
        b.click(partial(pick_specialty, i), [st, chatbot], OUT)
    btn_more_specs.click(more_specialties, [st, chatbot], OUT)
    btn_appt.click(pick_appointment, [appt_choice, st, chatbot], OUT)
    btn_confirm.click(confirm, [advance_cb, prof_name, prof_birth, prof_contact, st, chatbot], OUT).then(
        lambda s: (who_line(s.get("patient")), render_appointments(s), *render_notifications(s)), st, [who, appts_md, notif_md, badge])
    btn_discard.click(discard, [st, chatbot], OUT)
    for b, item, lbl in menu_btns:
        b.click(partial(lambda it, lb, s, c: send_action({"type": "menu", "item": it}, s, c, lb), item, lbl), [st, chatbot], OUT)
    btn_refresh_chat.click(refresh_history, [st, chatbot], OUT)

    # Menú ⋮
    btn_code.click(menu_show_code, [st, chatbot], OUT)
    btn_recover_hint.click(menu_recover, [st, chatbot], OUT)
    btn_others.click(menu_revoke_others, [st, chatbot], OUT)
    btn_demo.click(None, [demo_user, demo_pass], None, js="(u, p) => window.scAccess('demo', { username: u, password: p })")
    btn_logout.click(None, None, None, js="() => window.scAccess('salir', {}, '¿Cerrar la sesión en este dispositivo? "
                     "Para volver a tus citas necesitarás tu código de recuperación.')")

    btn_refresh_appts.click(render_appointments, st, appts_md)
    tab_appts.select(render_appointments, st, appts_md)
    OFFER_OUT = [st] + [w for group in offer_widgets for w in group]
    btn_refresh_notif.click(render_notifications, st, [notif_md, badge]).then(render_offers, st, OFFER_OUT)
    tab_notif.select(render_notifications, st, [notif_md, badge]).then(render_offers, st, OFFER_OUT)
    for i, (_col, _md, acc, rej) in enumerate(offer_widgets):
        acc.click(partial(answer_offer, i, "accept"), st, OFFER_OUT + [offer_msg, notif_md, badge, appts_md])
        rej.click(partial(answer_offer, i, "reject"), st, OFFER_OUT + [offer_msg, notif_md, badge, appts_md])
    btn_read_all.click(mark_all_read, st, [notif_md, badge])
    btn_notif_cmd.click(notif_command, [notif_cmd, st], [st, notif_md, badge, appts_md, notif_cmd])
    # Sondeo cada 10 s SIN indicador de carga: si no hay novedades nada cambia en pantalla (antes cada paso mostraba
    # la animación de «cargando» sobre la conversación y parecía que el chat se recargaba solo)
    quiet = {"show_progress": "hidden"}
    gr.Timer(10).tick(render_notifications, st, [notif_md, badge], **quiet).then(render_offers, st, OFFER_OUT, **quiet).then(
        lambda s: render_appointments(s), st, appts_md, **quiet).then(watch_confirmation, [st, chatbot], [st, chatbot], **quiet).then(
        watch_receipt, [st, chatbot], [st, chatbot], **quiet)


if __name__ == "__main__":
    raise SystemExit("Ejecuta el servidor con «uvicorn server:app»: crea la sesión invitada y fija la cookie HttpOnly.")
