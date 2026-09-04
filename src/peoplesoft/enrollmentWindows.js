import { db, lastSync, logSync } from '../db.js';
import { STUDENT_CENTER_URL } from './grades.js';
import { enrollmentWindowSchema } from '../shared/schemas.ts';

// Recon: fixtures/recon-enrollment-appointment.html. PeopleSoft llama a esta
// pantalla "Enrollment Appointments", pero para esta cuenta solo publica
// Open Enrollment Dates by Session: fecha inicial/final, sin hora del día.

export function extractEnrollmentWindows() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim() : '');
  const termCode = (document.documentElement.innerHTML.match(/STRM:"(\d+)"/) ?? [])[1] ?? null;
  const rows = [];
  for (const el of document.querySelectorAll('[id]')) {
    const match = el.id.match(/^OPEN_NAME\$(\d+)$/);
    if (!match) continue;
    const i = match[1];
    rows.push({
      session: strip(el),
      startsAt: strip(document.getElementById(`OPEN_START$${i}`)),
      endsAt: strip(document.getElementById(`OPEN_END$${i}`)),
    });
  }
  return { termCode, rows };
}

const MONTHS = new Map(
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map(
    (month, index) => [month.toLowerCase(), index + 1]
  )
);

export function portalDateToISO(raw) {
  const match = (raw ?? '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(.+))?$/);
  if (!match) throw new Error(`Fecha de inscripción no reconocida: ${raw || '(vacía)'}`);
  const month = MONTHS.get(match[1].toLowerCase());
  if (!month) throw new Error(`Mes de inscripción no reconocido: ${match[1]}`);
  const date = `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
  // La pantalla reconocida no trae hora. Si un parche futuro la agrega, no la
  // interpretamos a ciegas: el parser fallará y pedirá un recon nuevo.
  if (match[4]) throw new Error(`PeopleSoft empezó a publicar hora de inscripción; hace falta actualizar el parser: ${raw}`);
  return date;
}

export function parseEnrollmentWindows(raw) {
  if (!raw.termCode) throw new Error('Enrollment Dates no indicó el código de ciclo');
  return raw.rows.map((row) => ({
    termCode: raw.termCode,
    session: row.session || 'Regular Academic Session',
    startsAt: portalDateToISO(row.startsAt),
    endsAt: portalDateToISO(row.endsAt),
    precision: 'date',
  }));
}

export function saveEnrollmentWindows(userId, windows) {
  const insert = db.prepare(
    `INSERT INTO enrollment_windows
       (term_code, session, starts_at, ends_at, precision, user_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, term_code, session) DO UPDATE SET
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       precision = excluded.precision,
       synced_at = datetime('now')`
  );
  db.exec('BEGIN');
  try {
    for (const window of windows) {
      insert.run(
        window.termCode,
        window.session,
        window.startsAt,
        window.endsAt,
        window.precision,
        userId
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  logSync({ userId, kind: 'enrollmentWindows', status: 'ok', rows: windows.length, detail: windows[0]?.termCode ?? null });
  return windows.length;
}

export function readEnrollmentWindows(userId, termCode = null) {
  const rows = db
    .prepare(
      `SELECT term_code, session, starts_at, ends_at, precision, user_id, synced_at
       FROM enrollment_windows
       WHERE user_id = ? ${termCode ? 'AND term_code = ?' : ''}
       ORDER BY starts_at, session`
    )
    .all(userId, ...(termCode ? [termCode] : []))
    .map((row) =>
      enrollmentWindowSchema.parse({
        termCode: row.term_code,
        session: row.session,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        precision: row.precision,
        userId: row.user_id,
        syncedAt: row.synced_at,
      })
    );
  return { syncedAt: lastSync('enrollmentWindows', { userId }), windows: rows };
}

async function findFrame(page, selector, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator(selector).count()) > 0) return frame;
      } catch {
        // frame desprendido durante submitAction
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

export async function syncEnrollmentWindows(page, { userId, onStep = () => {} }) {
  try {
    onStep('abriendo Enrollment Dates…');
    await page.goto(STUDENT_CENTER_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6_000);
    let frame = await findFrame(
      page,
      'a[id^="DERIVED_SSS_SCL_SSS_LINK_OPENENRL"], a:has-text("Open Enrollment Dates")'
    );
    if (!frame) throw new Error('PeopleSoft no mostró el enlace Open Enrollment Dates');
    await frame
      .locator('a[id^="DERIVED_SSS_SCL_SSS_LINK_OPENENRL"], a:has-text("Open Enrollment Dates")')
      .first()
      .click();
    await page.waitForTimeout(6_000);
    frame = await findFrame(page, '[id^="OPEN_START$"]');
    if (!frame) {
      // Que la pantalla abra sin una sola fila NO es un parser roto: entre el
      // cierre de una ventana y la publicación de la siguiente, PeopleSoft no
      // tiene ninguna cita que mostrar, y eso dura meses. Tratarlo como error
      // dejaba la fuente vencida para siempre y reintentando cada media hora.
      // Se distingue por el título de la transacción, que sí está siempre que
      // la pantalla haya cargado.
      const loaded = await findFrame(page, '[id^="DERIVED_REGFRM1_SS_TRANSACT_TITLE"]', 4_000);
      if (!loaded) throw new Error('PeopleSoft no abrió Enrollment Dates');
      // La ventana anterior se conserva a propósito: sigue siendo el último
      // dato bueno y la UI la muestra con su antigüedad.
      logSync({ userId, kind: 'enrollmentWindows', status: 'ok', rows: 0, detail: 'el portal no publica ninguna ventana ahora' });
      return [];
    }
    onStep('leyendo la ventana publicada…');
    const windows = parseEnrollmentWindows(await frame.evaluate(extractEnrollmentWindows));
    saveEnrollmentWindows(userId, windows);
    return windows;
  } catch (error) {
    logSync({ userId, kind: 'enrollmentWindows', status: 'error', detail: error.message });
    throw error;
  }
}
