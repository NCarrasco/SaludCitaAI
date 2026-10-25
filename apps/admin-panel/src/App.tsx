import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type AdminUser, ApiError, type Catalog, type Role, api, setUnauthorizedHandler } from './api';
import { Filters, type StatsFilter, defaultFilter } from './components/Filters';
import { TZ } from './format';
import { useApi } from './hooks';
import { LiveProvider, useLive } from './live';
import { DashboardPage, type DashFilter, defaultDashFilter } from './pages/Dashboard';
import { AppointmentsPage } from './pages/Appointments';
import { HandoffsPage } from './pages/Handoffs';
import { type ConfigSection, MaintenancePage } from './pages/Maintenance';
import { OccupancyPage } from './pages/Occupancy';
import { AdvancesPage } from './pages/OffersAssistant';
import { SummaryPage } from './pages/Summary';
import { type SystemSection, SystemPage } from './pages/System';

/**
 * Navegación por tareas del personal. Principal: Inicio, Citas, Solicitudes de ayuda, Estadísticas, Configuración.
 * Secundario: Sistema (diagnóstico técnico, solo admin). Cada sección con subsecciones tiene su propia ruta
 * (#/seccion/subseccion?filtros) para enlaces profundos. Los permisos se aplican en la API; el menú solo refleja el rol.
 */
type Page = 'inicio' | 'citas' | 'ayuda' | 'estadisticas' | 'configuracion' | 'sistema';
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
interface Sub { id: string; label: string; secondary?: boolean }
interface NavItem { id: Page; label: string; min: Role; icon: string; subs?: Sub[]; technical?: boolean }
const NAV: NavItem[] = [
  { id: 'inicio', label: 'Inicio', min: 'viewer', icon: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z' },
  { id: 'citas', label: 'Citas', min: 'operator', icon: 'M3 5h18v16H3zM3 10h18M8 2v6M16 2v6' },
  { id: 'ayuda', label: 'Solicitudes de ayuda', min: 'operator', icon: 'M4 6h16v10H8l-4 4z' },
  { id: 'estadisticas', label: 'Estadísticas', min: 'viewer', icon: 'M4 13h6V4H4zm10 7h6V4h-6zM4 20h6v-4H4z',
    subs: [{ id: 'actividad', label: 'Actividad' }, { id: 'ocupacion', label: 'Ocupación' }, { id: 'adelantos', label: 'Adelantos' }] },
  { id: 'configuracion', label: 'Configuración', min: 'admin', icon: 'M14 6l4 4-9 9H5v-4zM13 7l4 4',
    subs: [{ id: 'profesionales', label: 'Profesionales' }, { id: 'agenda', label: 'Agenda' }, { id: 'centro', label: 'Centro' },
           { id: 'vista-previa', label: 'Vista previa al paciente', secondary: true }] },
  { id: 'sistema', label: 'Sistema', min: 'admin', technical: true, icon: 'M4 7h16M4 12h16M4 17h10',
    subs: [{ id: 'integraciones', label: 'Integraciones' }, { id: 'trabajos', label: 'Trabajos y reintentos' }, { id: 'asistente', label: 'Diagnóstico del asistente' }] },
];
const ROLE_LABEL: Record<Role, string> = { viewer: 'Consulta de estadísticas', operator: 'Operación', admin: 'Administración' };

/** Rutas anteriores → nuevas (los enlaces guardados siguen funcionando). */
const LEGACY: Record<string, string> = {
  resumen: 'estadisticas/actividad', analisis: 'estadisticas/actividad', ocupacion: 'estadisticas/ocupacion', ofertas: 'estadisticas/adelantos',
  traspasos: 'ayuda', mantenimiento: 'configuracion/profesionales', integraciones: 'sistema/integraciones',
};

/** Ruta: #/pagina[/subseccion]?param=valor (los parámetros filtran listados; las fechas «to» de la URL se entienden incluidas). */
const parseHash = (): { page: Page; sub: string; params: URLSearchParams } => {
  let [path, q] = location.hash.replace(/^#\/?/, '').split('?');
  const legacy = LEGACY[path ?? ''];
  if (legacy) { path = legacy; history.replaceState(null, '', `#/${legacy}${q ? `?${q}` : ''}`); }
  const [p, sub] = (path ?? '').split('/');
  return { page: (p as Page) || 'inicio', sub: sub ?? '', params: new URLSearchParams(q ?? '') };
};

export function App() {
  const [user, setUser] = useState<AdminUser | null | undefined>(undefined);
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api<{ user: AdminUser }>('/auth/me').then((r) => setUser(r.user), () => setUser(null));
  }, []);
  const ended = useCallback(() => setUser(null), []);
  if (user === undefined) return <div className="boot"><span className="spinner" aria-hidden="true" />Cargando panel…</div>;
  if (user === null) return <Login onLogin={setUser} />;
  // La sesión completa (datos, filtros y conexión en vivo) se monta por usuario: al salir o cambiar de usuario no queda nada
  return <LiveProvider key={user.id} onSessionEnded={ended}><Shell user={user} onLogout={() => setUser(null)} /></LiveProvider>;
}

function Shell({ user, onLogout }: { user: AdminUser; onLogout: () => void }) {
  const [{ page, sub, params }, setRoute] = useState(parseHash());
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState<StatsFilter>(defaultFilter());
  const [dashFilter, setDashFilter] = useState<DashFilter>(defaultDashFilter());
  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); setMenuOpen(false); };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const catalog = useApi<Catalog>('/admin/catalog', { topics: ['catalog'] });

  const allowed = NAV.filter((x) => RANK[user.role] >= RANK[x.min]);
  const denied = page !== 'inicio' && !allowed.some((x) => x.id === page) && NAV.some((x) => x.id === page);
  const current = allowed.find((x) => x.id === page) ?? allowed[0]!;
  const subId = current.subs?.some((x) => x.id === sub) ? sub : current.subs?.[0]?.id ?? '';
  const subLabel = current.subs?.find((x) => x.id === subId)?.label;
  const canOperate = RANK[user.role] >= RANK.operator;
  const showPeriod = current.id === 'estadisticas' || (current.id === 'sistema' && subId === 'asistente');
  useEffect(() => { document.title = `${subLabel ? `${subLabel} · ` : ''}${current.label} · SaludCita AI`; }, [current.label, subLabel]);

  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } finally { onLogout(); }
  }
  const link = (x: NavItem) => (
    <a key={x.id} href={`#/${x.id}`} aria-current={x.id === current.id ? 'page' : undefined}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={x.icon} /></svg>{x.label}
    </a>
  );

  return (
    <div className="layout">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="sidebar-inner">
        <div className="brand-row">
          <a className="brand" href="#/inicio"><span className="logo" aria-hidden="true">+</span><span>SaludCita AI<small>Panel administrativo</small></span></a>
          <button type="button" className="ghost menu-toggle" aria-expanded={menuOpen} aria-controls="nav" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? 'Cerrar' : 'Menú'}</button>
        </div>
        <nav id="nav" aria-label="Secciones">
          {allowed.filter((x) => !x.technical).map(link)}
          {allowed.some((x) => x.technical) && <><p className="nav-group" aria-hidden="true">Técnico</p>{allowed.filter((x) => x.technical).map(link)}</>}
        </nav>
        <div className="sidebar-foot">
          <div className="user"><strong>{user.display_name ?? user.email}</strong><span>{user.email}</span><span className="role">{ROLE_LABEL[user.role]}</span></div>
          <button type="button" onClick={logout}>Cerrar sesión</button>
          <p className="muted small">Hospital simulado · datos ficticios</p>
        </div>
        </div>
      </aside>
      <main>
        <header className="page-head">
          <div><p className="eyebrow">SaludCita AI · Consulta externa</p><h1>{current.label}</h1></div>
          <LiveStatus />
        </header>
        {denied && <div className="notice warn" role="alert">Tu rol ({ROLE_LABEL[user.role]}) no tiene acceso a esa sección. Te mostramos {current.label}.</div>}
        {current.subs && (
          <nav className="subnav" aria-label={`Secciones de ${current.label}`}>
            {current.subs.map((x) => (
              <a key={x.id} href={`#/${current.id}/${x.id}`} className={x.secondary ? 'secondary' : undefined} aria-current={x.id === subId ? 'page' : undefined}>{x.label}</a>
            ))}
          </nav>
        )}
        {showPeriod && <Filters value={filter} onChange={setFilter} catalog={catalog.data} />}
        {current.id === 'inicio' && <DashboardPage canOperate={canOperate} canAdmin={user.role === 'admin'} catalog={catalog.data} filter={dashFilter} onFilter={setDashFilter} />}
        {current.id === 'citas' && <AppointmentsPage key={params.toString()} catalog={catalog.data} params={params} />}
        {current.id === 'ayuda' && <HandoffsPage />}
        {current.id === 'estadisticas' && subId === 'actividad' && <SummaryPage filter={filter} canOperate={canOperate} />}
        {current.id === 'estadisticas' && subId === 'ocupacion' && <OccupancyPage filter={filter} />}
        {current.id === 'estadisticas' && subId === 'adelantos' && <AdvancesPage filter={filter} />}
        {current.id === 'configuracion' && <MaintenancePage catalogQ={catalog} section={subId as ConfigSection} />}
        {current.id === 'sistema' && <SystemPage section={subId as SystemSection} filter={filter} />}
      </main>
    </div>
  );
}

/** Estado de la conexión en vivo y hora del último aviso real recibido. */
function LiveStatus() {
  const { status, lastEventAt } = useLive();
  const label = { connecting: 'Conectando…', live: 'En vivo', reconnecting: 'Reconectando…', offline: 'Sin conexión en vivo' }[status];
  const t = lastEventAt?.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <p className={`live-status ${status}`} role="status" aria-live="polite" title={`Zona horaria ${TZ}`}>
      <span className="live-dot" aria-hidden="true" />{label}
      <span className="muted">{t ? ` · último cambio ${t}` : status === 'live' ? ' · sin cambios desde que abriste el panel' : ''}</span>
    </p>
  );
}

const DEMO_EMAIL = 'admin@saludcita.test';
const DEMO_PASSWORD = '12345678';

function Login({ onLogin }: { onLogin: (u: AdminUser) => void }) {
  // Prototipo local con datos ficticios: el formulario llega rellenado con la cuenta de administración de demostración
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ user: AdminUser }>('/auth/login', { method: 'POST', body: { email, password } });
      setPassword('');
      onLogin(r.user);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : (err as ApiError).message);
    } finally { setBusy(false); }
  }
  return (
    <main className="login">
      <form onSubmit={submit} className="card login-card" aria-labelledby="login-title">
        <div className="brand"><span className="logo" aria-hidden="true">+</span><span>SaludCita AI<small>Panel administrativo</small></span></div>
        <h1 id="login-title">Iniciar sesión</h1>
        <p className="muted small">Personal del hospital simulado. Cuentas de demostración: panel@, operador@ y admin@saludcita.test.</p>
        <p className="demo-hint">Contraseña de demostración (las tres cuentas): <strong>{DEMO_PASSWORD}</strong></p>
        <label>Correo<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="field-error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <p className="muted small">La sesión se guarda en una cookie protegida y caduca a las 8 h.</p>
      </form>
    </main>
  );
}
