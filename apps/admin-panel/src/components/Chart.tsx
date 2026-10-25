import {
  ArcElement, BarController, BarElement, CategoryScale, Chart as ChartJS, type ChartConfiguration, DoughnutController, Filler, Legend,
  LinearScale, LineController, LineElement, PointElement, Tooltip,
} from 'chart.js';
import { useEffect, useRef, useState } from 'react';

ChartJS.register(BarController, BarElement, LineController, LineElement, PointElement, DoughnutController, ArcElement,
  CategoryScale, LinearScale, Tooltip, Legend, Filler);

/** Color de una variable CSS del tema actual (claro u oscuro). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const media = (q: string) => (typeof window !== 'undefined' ? window.matchMedia(q) : null);

/** Tema actual; cambia cuando el sistema pasa de claro a oscuro (los gráficos releen sus colores). */
export function useTheme(): 'light' | 'dark' {
  const mq = media('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState(Boolean(mq?.matches));
  useEffect(() => {
    if (!mq) return undefined;
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mq]);
  return dark ? 'dark' : 'light';
}

export interface DataTable { caption: string; columns: string[]; rows: (string | number)[][] }

/**
 * Gráfico con alternativa accesible. La instancia se crea una vez y se ACTUALIZA cuando cambian los datos (no se
 * destruye y recrea en cada aviso en vivo). Sin animación si el usuario pide movimiento reducido.
 * `table`: los mismos valores en una tabla navegable (una etiqueta aria en el canvas no permite explorar los datos).
 */
export function ChartView({ config, label, table, height = 260, tableVisibleNearby = false }: { config: ChartConfiguration; label: string; table: DataTable; height?: number; tableVisibleNearby?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<ChartJS | null>(null);
  const theme = useTheme();
  useEffect(() => {
    if (!canvas.current) return;
    const reduced = Boolean(media('(prefers-reduced-motion: reduce)')?.matches);
    ChartJS.defaults.color = cssVar('--muted');
    ChartJS.defaults.borderColor = cssVar('--line');
    ChartJS.defaults.font.family = getComputedStyle(document.body).fontFamily;
    const options = { responsive: true, maintainAspectRatio: false, animation: reduced ? false as const : { duration: 220 }, ...config.options };
    const c = chart.current;
    if (c && (c.config as { type?: string }).type === config.type) {
      c.data = config.data as never;
      c.options = options as never;
      c.update(reduced ? 'none' : undefined);
    } else {
      c?.destroy();
      chart.current = new ChartJS(canvas.current, { ...config, options } as ChartConfiguration);
    }
  }, [config, theme]);
  useEffect(() => () => { chart.current?.destroy(); chart.current = null; }, []);
  return (
    <figure className="chart-figure">
      <div className="chart" style={{ height }}><canvas ref={canvas} role="img" aria-label={`${label}. Los valores están en ${tableVisibleNearby ? 'la tabla junto al gráfico' : 'la tabla «Ver datos»'}.`} /></div>
      {!tableVisibleNearby && <details className="chart-data">
        <summary>Ver datos</summary>
        <div className="table-scroll" tabIndex={0} role="region" aria-label={table.caption}>
          <table className="data compact">
            <caption className="sr-only">{table.caption}</caption>
            <thead><tr>{table.columns.map((c, i) => <th key={c} className={i ? 'num' : undefined} scope="col">{c}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((v, j) => j ? <td key={j} className="num">{v}</td> : <th key={j} scope="row">{v}</th>)}</tr>)}</tbody>
          </table>
        </div>
      </details>}
    </figure>
  );
}
