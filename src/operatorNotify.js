// Alertas para quien opera la instancia. Web Push sirve al estudiante, pero a
// las 6am puede estar en No Molestar; tres fallos seguidos del portal tienen
// que salir por un canal independiente. ntfy es HTTP, gratis y no añade una
// cuenta ni una dependencia al deploy.

const topic = (process.env.MIKAMPUS_OPERATOR_NTFY_TOPIC ?? '').trim();
const base = (process.env.MIKAMPUS_OPERATOR_NTFY_URL ?? 'https://ntfy.sh').replace(/\/$/, '');
const failures = new Map();

function configured() {
  return /^[A-Za-z0-9_-]{1,64}$/.test(topic);
}

let transport = async ({ title, body }) => {
  if (!configured()) return false;
  const response = await fetch(`${base}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: title, Priority: 'urgent', Tags: 'warning,rotating_light' },
    body,
  });
  if (!response.ok) throw new Error(`ntfy respondió HTTP ${response.status}`);
  return true;
};

export function setOperatorTransport(next) {
  const previous = transport;
  transport = next;
  return () => {
    transport = previous;
  };
}

// Devuelve el número consecutivo para que el caller pueda registrarlo. Solo
// alerta al tercer fallo y luego cada tercero; un error permanente no convierte
// el canal de emergencia en spam.
export async function reportOperatorFailure(key, detail) {
  const count = (failures.get(key) ?? 0) + 1;
  failures.set(key, count);
  if (count < 3 || count % 3 !== 0) return { count, alerted: false };
  try {
    const sent = await transport({
      title: `mikampus: ${count} fallos seguidos`,
      body: `${key}\n${detail}`,
    });
    if (!sent) console.warn('[operator] alerta no configurada; definí MIKAMPUS_OPERATOR_NTFY_TOPIC');
    return { count, alerted: sent };
  } catch (err) {
    console.warn(`[operator] no se pudo enviar alerta: ${err.message}`);
    return { count, alerted: false };
  }
}

export function reportOperatorSuccess(key) {
  failures.delete(key);
}

export function __resetOperatorFailures() {
  failures.clear();
}
