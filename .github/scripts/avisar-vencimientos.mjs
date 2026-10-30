// Aviso diario de vencimientos por ntfy. Lo corre GitHub Actions (aviso-vencimientos.yml),
// con el panel cerrado. Lee el último backup subido por el panel y arma un solo mensaje.
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const rutas = [process.env.VENC_PATH || 'avisos/vencimientos.json', process.env.BACKUP_PATH || 'backups/backup.json'];
const rama = process.env.BACKUP_REF || 'ig-backups';
const forzar = process.env.FORZAR === 'true';

async function traerBackup() {
  for (const ruta of rutas) {
    const base = 'https://api.github.com/repos/' + repo + '/contents/' + ruta.split('/').map(encodeURIComponent).join('/');
    for (const ref of [rama, '']) {
      const r = await fetch(base + (ref ? '?ref=' + encodeURIComponent(ref) : ''), {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' }
      });
      if (r.ok) return JSON.parse(await r.text());
      if (r.status !== 404) throw new Error('GitHub devolvió HTTP ' + r.status);
    }
  }
  throw new Error('No encontré los vencimientos en GitHub. Abrí el panel, Vencimientos, y tocá Guardar.');
}

const hoyAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
const ms = (iso) => Date.parse(iso + 'T00:00:00Z');
const diasHasta = (iso) => Math.round((ms(iso) - ms(hoyAR)) / 86400000);
const ultimoDia = (a, m) => new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
const iso = (a, m, d) => a + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');

function proxima(diaMes) {
  let [a, m, d] = hoyAR.split('-').map(Number); m -= 1;
  let dia = Math.min(diaMes, ultimoDia(a, m));
  if (dia < d) { m += 1; if (m > 11) { m = 0; a += 1; } dia = Math.min(diaMes, ultimoDia(a, m)); }
  return iso(a, m, dia);
}
const fmtFecha = (f) => f.split('-').reverse().join('/');
const fmtMonto = (n) => '$' + Math.round(n).toLocaleString('es-AR');

const data = await traerBackup();
const vz = data && data.vencimientos;
if (!vz) throw new Error('El backup no trae vencimientos.');
const cfg = vz.ntfyAviso || {};
const topic = (process.env.NTFY_TOPIC_VENC || cfg.topic || '').replace(/[^A-Za-z0-9_-]/g, '');
const anticipo = Math.max(1, parseInt(cfg.dias, 10) || 3);

if (!cfg.activo && !forzar) { console.log('El aviso está desactivado en el panel. No se envía nada.'); process.exit(0); }
if (!topic) throw new Error('Falta el canal de ntfy: completalo en Vencimientos > Aviso por ntfy y guardá.');

const ocultos = vz.impuestosOcultos || [];
const todos = []
  .concat((vz.impuestos || []).filter((i) => ocultos.indexOf(i.id) === -1))
  .concat(vz.servicios || [])
  .map((v) => ({ nombre: v.nombre, monto: v.monto, fecha: v.recurrente && v.diaMes ? proxima(v.diaMes) : v.fecha }))
  .filter((v) => v.fecha);

// Avisa cuando faltan N días, cuando falta 1 y el mismo día.
const toca = new Set([anticipo, 1, 0]);
let lista = todos.map((v) => ({ ...v, dias: diasHasta(v.fecha) })).filter((v) => toca.has(v.dias));
if (forzar && !lista.length) lista = todos.map((v) => ({ ...v, dias: diasHasta(v.fecha) })).filter((v) => v.dias >= 0 && v.dias <= anticipo);
lista.sort((a, b) => a.dias - b.dias);

if (!lista.length) { console.log('Hoy (' + hoyAR + ') no toca avisar nada.'); process.exit(0); }

const cuando = (d) => (d === 0 ? 'HOY' : d === 1 ? 'mañana' : 'en ' + d + ' días');
const lineas = lista.map((v) => '• ' + v.nombre + ' — ' + cuando(v.dias) + ' (' + fmtFecha(v.fecha) + ')' + (v.monto ? ' · ' + fmtMonto(v.monto) : ''));
const hayHoy = lista.some((v) => v.dias === 0);
const r = await fetch('https://ntfy.sh/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    topic,
    title: (hayHoy ? '⏰ Vence hoy' : '⏰ Vencimientos próximos') + ' (' + lista.length + ')',
    message: lineas.join('\n'),
    priority: hayHoy ? 4 : 3,
    tags: ['alarm_clock']
  })
});
if (!r.ok) throw new Error('ntfy respondió ' + r.status + ' ' + (await r.text()).slice(0, 200));
console.log('Aviso enviado (' + lista.length + ' vencimiento/s):\n' + lineas.join('\n'));
