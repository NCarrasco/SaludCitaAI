// SaludCita · comportamiento de la ventana de mensajería (sin dependencias ni recursos externos).
// - Sonidos generados con Web Audio: tecla, enviar y respuesta recibida. Preferencia solo en este navegador.
// - Menú ⋮ accesible (Escape y clic fuera lo cierran).
// - Rutas /acceso/* del propio servidor (mismo origen + cabecera propia) para la cookie HttpOnly.
(() => {
  // ---------- Siempre en tema claro: Gradio activa el oscuro si el teléfono lo usa (clase .dark); se quita al instante ----------
  const light = () => document.querySelectorAll('.dark').forEach((el) => el.classList.remove('dark'));
  document.documentElement.style.colorScheme = 'light';
  light();
  new MutationObserver(light).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  // ---------- Dentro del asistente flotante (iframe): el chat ocupa todo el panel ----------
  let embedded = false;
  try { embedded = window.self !== window.top; } catch (e) { embedded = true; }
  if (embedded) {
    document.documentElement.classList.add('sc-embedded');
    // Botón «minimizar» en la cabecera: avisa a la página contenedora (mismo origen) para cerrar el panel
    const addMin = () => {
      const head = document.querySelector('.sc-wa-head');
      if (!head) return setTimeout(addMin, 300);
      if (head.querySelector('.sc-wa-min')) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sc-wa-iconbtn sc-wa-min'; b.style.color = 'var(--wa-head-text)'; b.setAttribute('aria-label', 'Minimizar el chat');
      b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
      b.addEventListener('click', () => { try { window.parent.postMessage({ type: 'salu:close' }, location.origin); } catch (e) { /* nada */ } });
      head.appendChild(b);
      // Fija arriba el bloque de Gradio que contiene la cabecera (hijo directo de la ventana): así queda visible al desplazarse
      let blk = head; while (blk.parentElement && !blk.parentElement.classList.contains('sc-wa')) blk = blk.parentElement;
      if (blk.parentElement) Object.assign(blk.style, { position: 'sticky', top: '0', zIndex: '30' });
    };
    addMin();
    // La conversación ocupa el alto que dejan libre la cabecera, las opciones (citas, horarios, propuesta) y la caja de
    // texto. Se recalcula cuando aparecen o desaparecen opciones o cambia el tamaño del panel.
    let fitting = false;
    const fit = () => {
      if (fitting) return; fitting = true;
      requestAnimationFrame(() => {
        const chat = document.querySelector('#sc-chat'), win = document.querySelector('.sc-wa');
        if (chat && win) {
          // Alto del CONTENIDO (no de la ventana, que tiene alto mínimo de pantalla completa): el último hijo visible
          const kids = [...win.children].filter((k) => k.getBoundingClientRect().height > 0);
          const contentBottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
          const others = contentBottom - win.getBoundingClientRect().top - chat.getBoundingClientRect().height;
          const h = Math.max(120, Math.floor(window.innerHeight - others - 2));
          if (Math.abs(chat.getBoundingClientRect().height - h) > 2) chat.style.setProperty('height', h + 'px', 'important');
          // Si las opciones no caben, la ventana se desplaza: se baja una vez para mostrar botones y caja de texto;
          // cuando vuelve a caber todo, se vuelve arriba (sin hueco debajo)
          const tooTall = others + 120 > window.innerHeight;
          if (tooTall && !fit.scrolled) { fit.scrolled = true; setTimeout(() => window.scrollTo({ top: document.documentElement.scrollHeight }), 50); }
          if (!tooTall) { fit.scrolled = false; if (window.scrollY > 0) window.scrollTo({ top: 0 }); }
        }
        fitting = false;
      });
    };
    addEventListener('resize', fit);
    new MutationObserver(fit).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    setInterval(fit, 1500);
  }
  // ---------- Servidor reiniciado (despliegue): la página abierta pierde su sesión de Gradio y las pestañas dejan de
  // cargar sin avisar. Se compara el identificador de arranque y, si cambió, se avisa y se recarga. ----------
  (() => {
    const base = location.pathname.replace(/\/?$/, '/');
    let appId = null;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch(base + 'config', { cache: 'no-store' });
        if (!r.ok) return;
        const id = String((await r.json()).app_id);
        if (appId === null) { appId = id; return; }
        if (id !== appId) {
          const n = document.createElement('div');
          n.className = 'sc-reload'; n.setAttribute('role', 'status'); n.textContent = 'Salu se actualizó. Recargando la conversación…';
          document.body.appendChild(n);
          setTimeout(() => location.reload(), 1200);
        }
      } catch (e) { /* sin conexión: se reintenta */ }
    };
    check(); setInterval(check, 20000);
    document.addEventListener('visibilitychange', check);
  })();
  // ---------- Sonido ----------
  let ctx = null;
  let on = true;        // sonidos de envío y recepción (activados por defecto, silenciables)
  let keysOn = false;   // clic por tecla: preferencia independiente, DESACTIVADA por defecto
  try { on = localStorage.getItem('sc-sound') !== 'off'; keysOn = localStorage.getItem('sc-keysound') === 'on'; } catch (e) { /* sin almacenamiento */ }
  // Safari y Chrome crean el AudioContext «suspendido» y solo lo dejan sonar si se reanuda dentro de un gesto del usuario.
  const audio = () => {
    try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  };
  // Desbloqueo en el primer toque, clic o tecla: reanuda el contexto y reproduce un búfer silencioso (requisito de iOS)
  const unlock = () => {
    const a = audio();
    if (!a) return;
    try { const b = a.createBufferSource(); b.buffer = a.createBuffer(1, 1, 22050); b.connect(a.destination); b.start(0); } catch (e) { /* sin audio */ }
    if (a.state === 'running') ['pointerdown', 'keydown', 'touchend'].forEach((t) => document.removeEventListener(t, unlock, true));
  };
  ['pointerdown', 'keydown', 'touchend'].forEach((t) => document.addEventListener(t, unlock, true));
  const tone = (freqs, dur, gain = 0.14, type = 'sine') => {
    if (!on) return;
    const a = audio();
    if (!a) return;
    const t0 = a.currentTime;
    freqs.forEach((f, i) => {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type; o.frequency.value = f;
      const t = t0 + i * dur;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
    });
  };
  // Clic de tecla: ruido corto filtrado, muy suave (como el teclado del teléfono)
  let lastKey = 0;
  const keyClick = () => {
    if (!on || !keysOn) return;
    const now = performance.now();
    if (now - lastKey < 35) return;
    lastKey = now;
    const a = audio();
    if (!a) return;
    const len = Math.floor(a.sampleRate * 0.018);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = a.createBufferSource();
    const f = a.createBiquadFilter();
    const g = a.createGain();
    f.type = 'bandpass'; f.frequency.value = 2400 + Math.random() * 600; f.Q.value = 1.2;
    g.gain.value = 0.4;
    src.buffer = buf; src.connect(f).connect(g).connect(a.destination); src.start();
  };
  let lastSend = 0;
  window.scSound = {
    send: () => { lastSend = Date.now(); tone([660, 880], 0.07, 0.14); },
    receive: () => tone([880, 1175], 0.08, 0.12),
  };

  const syncSound = () => {
    document.querySelectorAll('.sc-wa-sound').forEach((b) => {
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Silenciar sonidos' : 'Activar sonidos');
      b.title = on ? 'Sonidos activados' : 'Sonidos silenciados';
    });
    document.querySelectorAll('.sc-keysound').forEach((b) => b.setAttribute('aria-pressed', String(keysOn)));
  };

  // ---------- Menú ⋮ ----------
  const win = () => document.querySelector('.sc-wa');
  const kebabBtn = () => document.querySelector('.sc-wa-kebab-btn');
  const setKebab = (open) => {
    const w = win(); const b = kebabBtn();
    if (!w) return;
    w.classList.toggle('kebab-open', open);
    // Cerrado, el menú queda inerte: fuera del orden de tabulación y oculto a lectores de pantalla
    const k = document.querySelector('#sc-kebab');
    if (k) { k.inert = !open; k.setAttribute('aria-hidden', String(!open)); }
    if (b) b.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => document.querySelector('.sc-wa-kebab button')?.focus(), 30);
  };

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.sc-wa-sound')) {
      on = !on;
      try { localStorage.setItem('sc-sound', on ? 'on' : 'off'); } catch (e) { /* sin almacenamiento */ }
      syncSound(); if (on) tone([880], 0.06);
      return;
    }
    if (t.closest('.sc-keysound')) {
      keysOn = !keysOn;
      try { localStorage.setItem('sc-keysound', keysOn ? 'on' : 'off'); } catch (e) { /* sin almacenamiento */ }
      syncSound(); if (keysOn) keyClick();
      return;
    }
    if (t.closest('.sc-wa-kebab-btn')) { setKebab(!win()?.classList.contains('kebab-open')); return; }
    if (t.closest('.sc-wa-kebab .sc-mi, .sc-wa-kebab .sc-primary')) { setTimeout(() => setKebab(false), 60); }
    else if (!t.closest('.sc-wa-kebab')) setKebab(false);
    if (t.closest('.sc-wa-send, .sc-menu button, .sc-choice button, .sc-card-actions .sc-primary')) window.scSound.send();
  }, true);

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && win()?.classList.contains('kebab-open')) { setKebab(false); kebabBtn()?.focus(); return; }
    const t = ev.target;
    if (!(t instanceof Element) || !t.closest('.sc-wa-text')) return;
    if (ev.key === 'Enter' && !ev.shiftKey) { window.scSound.send(); return; }
    if (ev.key.length === 1 || ev.key === 'Backspace') keyClick();
  }, true);

  // ---------- Accesibilidad: la conversación se puede desplazar con el teclado; el menú cerrado es inerte ----------
  setInterval(() => {
    const k = document.querySelector('#sc-kebab');
    if (k && !win()?.classList.contains('kebab-open') && !k.inert) { k.inert = true; k.setAttribute('aria-hidden', 'true'); }
    const log = document.querySelector('#sc-chat .bubble-wrap');
    if (log && !log.hasAttribute('tabindex')) { log.setAttribute('tabindex', '0'); log.setAttribute('aria-label', 'Conversación con el asistente'); }
  }, 1000);

  // ---------- Respuesta recibida ----------
  // Suena solo cuando llega la respuesta a algo que el paciente acaba de enviar (no al cargar el historial)
  let seen = -1;
  setInterval(() => {
    syncSound();
    const n = [...document.querySelectorAll('.sc-wa-chat .bot-row')].filter((r) => !r.querySelector('.sc-typing')).length;
    if (seen >= 0 && n > seen && Date.now() - lastSend < 120000) window.scSound.receive();
    seen = n;
  }, 400);

  // ---------- Puente de la bandeja de avisos: [data-sc-cmd] → Textbox oculto + botón oculto (Python) ----------
  const bridge = (cmd) => {
    const ta = document.querySelector('#sc-bridge textarea, #sc-bridge input');
    const btn = document.querySelector('#sc-bridge-btn');
    if (!ta || !btn) return;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
    setter.call(ta, cmd);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => btn.click(), 60);
  };
  document.addEventListener('click', (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest('[data-sc-cmd]') : null;
    if (!el) return;
    ev.preventDefault(); ev.stopPropagation();
    const cmd = el.getAttribute('data-sc-cmd');
    if (cmd.startsWith('archive:')) { const li = el.closest('li'); if (li) li.classList.add('sc-leaving'); }
    if (cmd.startsWith('read:')) { el.classList.toggle('sc-open'); if (!el.classList.contains('sc-unread')) return; }
    bridge(cmd);
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target instanceof Element && ev.target.matches('li[data-sc-cmd]')) {
      ev.preventDefault(); ev.target.click();
    }
  });

  // ---------- Insignia de avisos sin leer en la pestaña (se actualiza con el sondeo de 10 s) ----------
  let lastUnread = null;
  setInterval(() => {
    const src = document.querySelector('.sc-badge-src');
    const n = parseInt((src?.textContent || '').trim(), 10) || 0;
    const tab = [...document.querySelectorAll('.sc-wa-tabs [role=tab]')].find((t) => /avisos/i.test(t.textContent || ''));
    if (!tab) return;
    if (n !== lastUnread) {
      if (n > 0) {
        tab.setAttribute('data-badge', n > 99 ? '99+' : String(n));
        tab.setAttribute('aria-label', `Avisos, ${n} sin leer`);
        tab.classList.remove('sc-pop'); void tab.offsetWidth; tab.classList.add('sc-pop');
        if (lastUnread !== null && n > lastUnread) tone([988, 1319], 0.08, 0.04);
      } else {
        tab.removeAttribute('data-badge'); tab.removeAttribute('aria-label');
      }
      lastUnread = n;
    }
  }, 500);

  // ---------- Fecha de nacimiento: Día / Mes / Año (patrón recomendado para fechas conocidas y lejanas) ----------
  // Un calendario obliga a retroceder décadas mes a mes; tres selectores nativos (ruedas en el móvil) no.
  // El campo de Gradio (#sc-birth) queda oculto y recibe la fecha compuesta AAAA-MM-DD.
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
  const birthPicker = () => {
    const host = document.querySelector('#sc-birth');
    const field = host?.querySelector('input, textarea');
    if (!host || !field || host.querySelector('.sc-dob')) return;
    const box = document.createElement('div');
    box.className = 'sc-dob'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Fecha de nacimiento');
    const mk = (cls, label, items) => {
      const s = document.createElement('select');
      s.className = cls; s.setAttribute('aria-label', label);
      s.append(opt('', label), ...items.map(([v, t]) => opt(v, t)));
      box.append(s); return s;
    };
    const pad = (n) => String(n).padStart(2, '0');
    const d = mk('sc-dob-d', 'Día', Array.from({ length: 31 }, (_, i) => [pad(i + 1), String(i + 1)]));
    const m = mk('sc-dob-m', 'Mes', MESES.map((n, i) => [pad(i + 1), n]));
    const y0 = new Date().getFullYear();
    const y = mk('sc-dob-y', 'Año', Array.from({ length: y0 - 1899 }, (_, i) => [String(y0 - i), String(y0 - i)]));
    const sync = () => {
      // Días del mes elegido (29 de febrero solo en bisiesto)
      const max = m.value ? new Date(Number(y.value) || 2000, Number(m.value), 0).getDate() : 31;
      [...d.options].forEach((o) => { if (o.value) o.disabled = Number(o.value) > max; });
      if (d.value && Number(d.value) > max) d.value = '';
      const iso = d.value && m.value && y.value ? `${y.value}-${m.value}-${d.value}` : '';
      const ok = !iso || iso <= new Date().toISOString().slice(0, 10);
      box.classList.toggle('sc-dob-error', !ok);
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, ok ? iso : '');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    [d, m, y].forEach((s) => s.addEventListener('change', sync));
    field.closest('label')?.after(box) ?? field.after(box);
    field.classList.add('sc-dob-src'); field.tabIndex = -1; field.setAttribute('aria-hidden', 'true');
  };
  // El puente interno nunca debe recibir foco con el teclado ni anunciarse a lectores de pantalla
  const hideBridge = () => document.querySelectorAll('#sc-bridge textarea, #sc-bridge input, #sc-bridge-btn').forEach((e) => {
    if (e.tabIndex !== -1) { e.tabIndex = -1; e.setAttribute('aria-hidden', 'true'); }
  });
  const onDom = () => { birthPicker(); hideBridge(); };
  new MutationObserver(onDom).observe(document.body, { childList: true, subtree: true });
  onDom();

  // ---------- Acceso (cookie HttpOnly gestionada por el servidor) ----------
  const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-saludcita-ui': '1' }, body: JSON.stringify(body || {}) });
  window.scAccess = async (action, body, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const r = await post('/acceso/' + action, body);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { window.alert(j.message || 'No se pudo completar la operación.'); return; }
      window.location.reload();
    } catch (e) { window.alert('No se pudo contactar con el servidor.'); }
  };
  // Tras recuperar el acceso dentro del chat: fija la cookie del nuevo dispositivo con un nonce de un solo uso
  window.scActivate = async (nonce) => {
    if (!nonce) return;
    try { await post('/acceso/activar', { nonce }); } catch (e) { /* la sesión sigue activa en esta pestaña */ }
  };
})();
