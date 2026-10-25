/**
 * Versión nueva del panel tras un despliegue: una pestaña abierta seguiría con el código anterior (y sin las funciones
 * nuevas) hasta recargarla. Se compara el script principal que sirve el servidor con el cargado y, si cambió, se recarga
 * en un momento seguro: sin ventana de detalle abierta ni un campo con el foco (para no perder lo que se está escribiendo).
 */
const BUNDLE = /assets\/index-[\w-]+\.js/;

export function watchForUpdates(everyMs = 60_000) {
  if (!import.meta.env.PROD) return;
  const loaded = [...document.scripts].map((s) => s.src.match(BUNDLE)?.[0]).find(Boolean);
  if (!loaded) return;
  let pending = false;
  const busy = () => Boolean(document.querySelector('[role=dialog], dialog[open]'))
    || (document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable]'));
  const tryReload = () => { if (pending && document.visibilityState === 'visible' && !busy()) location.reload(); };
  const check = async () => {
    if (!pending) {
      try {
        const r = await fetch(import.meta.env.BASE_URL, { cache: 'no-store' });
        const served = r.ok ? (await r.text()).match(BUNDLE)?.[0] : undefined;
        if (served && served !== loaded) pending = true;
      } catch { /* sin conexión: se reintenta */ }
    }
    tryReload();
  };
  setInterval(check, everyMs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  document.addEventListener('focusout', () => setTimeout(tryReload, 500));
}
