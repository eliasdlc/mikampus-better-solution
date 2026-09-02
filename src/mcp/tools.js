import { z } from 'zod';
import { feasibilityForGoal, projectFinalGpa, summarizeGrades, termSortKey } from '../shared/gpa.ts';
import { computeInsights } from '../shared/insights.ts';
import { meetingSetsOverlap } from '../shared/meetings.ts';
import { recommendCourses } from '../shared/recommend.ts';
import { resolveTermPhase, TERM_EVENT_LABELS } from '../shared/termPhase.ts';
import { careerSummary } from '../shared/trajectory.ts';
import { blockersEnvelopeSchema, upcomingEnvelopeSchema } from '../shared/mcp.ts';
import { agentState, expandBlocks, getBlockers, getUpcoming, localDate, resolveCycle } from './kino.js';
import { connectionMode } from './db.js';
import * as read from './read.js';

// Las herramientas de LECTURA del servidor MCP.
//
// Están mapeadas a preguntas y no a tablas: "cómo voy", "qué tengo esta
// semana", "qué puedo inscribir", "qué me está frenando". Una herramienta por
// tabla obligaría al agente a hacer seis llamadas y a reconstruir el modelo
// académico él mismo, que es exactamente donde inventaría.
//
// Todas devuelven el mismo sobre (src/shared/mcp.ts): data, freshness (qué tan
// viejo es lo que estás leyendo), warnings (qué tiene de sospechoso) y unknown
// (qué NO se sabe y por qué). El último es lo que hace imposible el placeholder.

const ALL_DATASETS = ['mySchedule', 'cart', 'grades', 'advisement', 'holds', 'enrollmentWindows', 'catalog'];

// Las fechas del calendario académico que PeopleSoft simplemente no publica.
// Salen nombradas en cada respuesta de ciclo para que un agente diga "no lo sé"
// en vez de estimar una fecha de retiro que nadie escribió nunca.
const PORTAL_SILENT_ON =
  'PeopleSoft no publica esta fecha: vive en el calendario académico de PUCMM, fuera del portal.';

function envelope({ data, summary, freshness = [], warnings = [], unknown = [], now }) {
  return {
    summary,
    payload: {
      asOf: now.toISOString(),
      data,
      freshness,
      warnings,
      unknown,
    },
  };
}

function creditsOf(course) {
  return course.units ?? 0;
}

// ── 1. get_overview ────────────────────────────────────────────────────────

function overview({ now }) {
  const profile = read.readProfile();
  const account = read.accountState();
  const cycle = resolveCycle(now);
  const target = cycle.current ?? cycle.next;
  const enrolled = target
    ? read.readEnrollments(read.LOCAL_USER_ID, target.term).filter((course) => course.status === 'enrolled')
    : [];
  const summary = summarizeGrades(
    read.readGrades().map((row) => ({ grade: row.grade, units: row.credits, status: row.status }))
  );
  const tree = read.readRequirementTree();
  const holds = read.readHolds();
  const agent = agentState();

  const data = {
    account: { hasAccount: account.hasAccount, lastLoginAt: account.lastLoginAt },
    profile: profile
      ? {
          career: profile.career,
          pensumNo: profile.pensumNo,
          planLabel: profile.planLabel,
          cohortStartTerm: profile.cohortStartTerm,
        }
      : null,
    cycle: { current: cycle.current, next: cycle.next },
    enrolled: enrolled.map((course) => ({
      code: course.code,
      title: course.title,
      units: course.units,
      components: course.sections.map((section) => `${section.component ?? '?'} ${section.section ?? ''}`.trim()),
    })),
    enrolledCredits: enrolled.reduce((total, course) => total + creditsOf(course), 0),
    gpa: { value: summary.gpa, unitsTowardGpa: summary.unitsTowardGpa, unitsPassed: summary.unitsPassed },
    remainingCredits: tree?.units?.needed ?? null,
    holds: { total: holds.length, blocking: holds.filter((hold) => hold.severity === 'blocking').length },
    agent,
  };

  const text = [
    profile?.career ? `Carrera ${profile.career} (pénsum ${profile.pensumNo ?? 'desconocido'}).` : 'Perfil sin sincronizar.',
    target ? `Ciclo ${target.label ?? target.term}: ${enrolled.length} materia(s), ${data.enrolledCredits} crédito(s).` : 'No hay un ciclo resuelto contra hoy.',
    summary.gpa === null ? 'Sin índice: no hay créditos calificados.' : `Índice ${summary.gpa.toFixed(3)} sobre ${summary.unitsTowardGpa} créditos.`,
  ].join(' ');

  return envelope({
    data,
    summary: text,
    freshness: read.freshnessFor(ALL_DATASETS, { now: now.getTime() }),
    warnings: read.termIntegrityWarnings(),
    unknown: tree ? [] : [{ kind: 'avance_del_pensum', reason: 'El informe de avance nunca se sincronizó.' }],
    now,
  });
}

// ── 2. get_cycle ───────────────────────────────────────────────────────────

// Las ventanas conocidas de un ciclo, en el vocabulario de shared/termPhase.ts.
// term_events es la tabla canónica, pero puede no existir todavía en una base
// instalada; cuando falta la fecha de inscripción se toma de enrollment_windows,
// que es el mismo hecho del portal escrito por el scraper viejo.
function eventsForTerm(termId) {
  const events = read
    .readTermEvents()
    .filter((row) => row.termCode === termId)
    .map((row) => ({
      event: row.event,
      session: row.session,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      source: row.source,
      sourceNote: row.sourceNote,
    }));

  if (!events.some((event) => event.event === 'inscripcion-regular')) {
    for (const window of read.readEnrollmentWindows().filter((row) => row.termCode === termId)) {
      events.push({
        event: 'inscripcion-regular',
        session: window.session,
        startsOn: window.startsAt ? window.startsAt.slice(0, 10) : null,
        endsOn: window.endsAt ? window.endsAt.slice(0, 10) : null,
        source: 'portal',
        sourceNote: 'enrollment-dates',
      });
    }
  }
  return events;
}

function cycle({ term, now }) {
  const resolved = resolveCycle(now);
  const target = term
    ? resolved.terms.find((entry) => entry.term === term || entry.code === term || entry.label === term) ?? null
    : resolved.current ?? resolved.next;

  if (!target) {
    return envelope({
      data: { terms: resolved.terms, current: null, next: null, phase: null },
      summary: 'No hay ningún ciclo que contenga a hoy ni uno próximo con fechas conocidas.',
      freshness: read.freshnessFor(['mySchedule', 'enrollmentWindows'], { now: now.getTime() }),
      warnings: read.termIntegrityWarnings(),
      unknown: [{ kind: 'ciclo_actual', reason: 'Ningún ciclo guardado tiene fechas que contengan a hoy.' }],
      now,
    });
  }

  const events = eventsForTerm(target.term);
  const phase = resolveTermPhase(events, { startDate: target.startDate, endDate: target.endDate }, now);

  return envelope({
    data: {
      terms: resolved.terms,
      current: resolved.current,
      next: resolved.next,
      term: target,
      phase,
      events,
    },
    summary: `Ciclo ${target.label ?? target.term}: etapa ${phase.phase} (${phase.confidence})${
      phase.daysLeft === null ? '' : `, quedan ${phase.daysLeft} día(s)`
    }.`,
    freshness: read.freshnessFor(['mySchedule', 'enrollmentWindows'], { now: now.getTime() }),
    warnings: read.termIntegrityWarnings(),
    // Cada etapa sin fecha se nombra: el agente sabe qué preguntas no puede
    // contestar en vez de estimar una fecha de retiro que nadie publicó.
    unknown: phase.missing.map((event) => ({
      kind: event,
      reason: `${TERM_EVENT_LABELS[event]} no tiene fecha cargada. ${PORTAL_SILENT_ON}`,
    })),
    now,
  });
}

// ── 3. get_schedule ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function schedule({ term, from, to, now }) {
  const resolved = resolveCycle(now);
  const target = term
    ? resolved.terms.find((entry) => entry.term === term || entry.label === term) ?? null
    : resolved.current ?? resolved.next;
  const fromIso = from ?? localDate(now);
  const toIso = to ?? localDate(new Date(now.getTime() + 7 * DAY_MS));

  const courses = target ? read.readEnrollments(read.LOCAL_USER_ID, target.term) : [];
  const blocks = expandBlocks(courses.filter((entry) => entry.status === 'enrolled'), fromIso, toIso);

  // La próxima clase se compara contra la hora LOCAL: "qué tengo ahora" es una
  // pregunta del reloj de Elias, no del reloj UTC.
  const nowStamp = `${localDate(now)}${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const next = blocks.find((block) => `${block.date}${block.start}` >= nowStamp) ?? null;

  return envelope({
    data: { term: target?.term ?? null, termLabel: target?.label ?? null, from: fromIso, to: toIso, blocks, nextClass: next },
    summary: next
      ? `${blocks.length} bloque(s) entre ${fromIso} y ${toIso}. Próxima clase: ${next.courseCode} el ${next.date} a las ${next.start}.`
      : `${blocks.length} bloque(s) entre ${fromIso} y ${toIso}. No queda ninguna clase en ese rango.`,
    freshness: read.freshnessFor(['mySchedule'], { now: now.getTime() }),
    warnings: read.termIntegrityWarnings(),
    unknown: courses.length === 0 ? [{ kind: 'horario', reason: 'No hay inscripciones guardadas para ese ciclo.' }] : [],
    now,
  });
}

// ── 4. get_academics ───────────────────────────────────────────────────────

function academics({ includeCourses, now }) {
  const rows = read.readGrades();
  const graded = rows.map((row) => ({ grade: row.grade, units: row.credits, status: row.status }));
  const summary = summarizeGrades(graded);

  const byTerm = new Map();
  for (const row of rows) {
    const list = byTerm.get(row.term) ?? [];
    list.push(row);
    byTerm.set(row.term, list);
  }
  const termSummaries = [...byTerm.entries()]
    .map(([term, list]) => {
      const termGpa = summarizeGrades(list.map((row) => ({ grade: row.grade, units: row.credits, status: row.status })));
      return { term, sortKey: termSortKey(term), gpa: termGpa.gpa, unitsTowardGpa: termGpa.unitsTowardGpa };
    })
    .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''));

  const insights = computeInsights(
    termSummaries,
    rows.map((row) => ({
      code: row.courseCode ?? '',
      subject: row.subject ?? '',
      term: row.term,
      grade: row.grade,
      units: row.credits,
      status: row.status,
    }))
  );

  const remainingCredits = read.readRequirementTree()?.units?.needed ?? 0;
  const goals = read.readGoals().map((goal) => ({
    id: goal.id,
    kind: goal.kind,
    target: goal.target,
    deadlineTerm: goal.deadlineTerm,
    feasibility: goal.kind === 'gpa' ? feasibilityForGoal(summary, remainingCredits, goal.target) : null,
  }));

  const data = {
    summary,
    termSummaries,
    insights,
    goals,
    projection: summary.unitsTowardGpa > 0 || remainingCredits > 0 ? projectFinalGpa(summary, remainingCredits) : null,
    courses: includeCourses ? rows : undefined,
  };

  return envelope({
    data,
    summary:
      summary.gpa === null
        ? 'No hay créditos calificados: no hay índice todavía.'
        : `Índice ${summary.gpa.toFixed(3)} sobre ${summary.unitsTowardGpa} créditos, ${termSummaries.length} ciclo(s) con notas.`,
    freshness: read.freshnessFor(['grades', 'advisement'], { now: now.getTime() }),
    warnings: read.termIntegrityWarnings(),
    unknown: remainingCredits === 0 ? [{ kind: 'creditos_faltantes', reason: 'El avance del pénsum no está sincronizado.' }] : [],
    now,
  });
}

// ── 5. get_degree_progress ─────────────────────────────────────────────────

function flattenGroups(node, out = []) {
  out.push(node);
  for (const child of node.children) flattenGroups(child, out);
  return out;
}

function degreeProgress({ status, term, now }) {
  const tree = read.readRequirementTree();
  if (!tree) {
    return envelope({
      data: { groups: [], totals: null, career: null },
      summary: 'El informe de avance nunca se sincronizó: no hay árbol de pénsum que leer.',
      freshness: read.freshnessFor(['advisement'], { now: now.getTime() }),
      warnings: [],
      unknown: [{ kind: 'avance_del_pensum', reason: 'Nunca se leyó el informe de avance del portal.' }],
      now,
    });
  }

  const resolved = resolveCycle(now);
  const planningTerm = term ?? resolved.current?.term ?? resolved.next?.term ?? null;
  const offered = new Set(planningTerm ? read.readSections(planningTerm).map((section) => section.code) : []);

  const groups = flattenGroups(tree)
    .filter((group) => group.kind === 'periodo' || group.kind === 'electiva' || group.kind === 'obligatorios')
    .filter((group) => (status === 'pending' ? !group.satisfied : true))
    .map((group) => ({
      label: group.label,
      kind: group.kind,
      year: group.year,
      period: group.period,
      satisfied: group.satisfied,
      unitsTaken: group.units.taken,
      unitsNeeded: group.units.needed,
      coursesNeeded: group.courses.needed,
      pending: group.items
        .filter((item) => (status === 'pending' ? item.status === 'pending' : true))
        .map((item) => ({
          code: item.code,
          title: item.title,
          units: item.units,
          isCandidate: item.isCandidate,
          offered: offered.has(item.code),
        })),
    }));

  const career = careerSummary(tree, {
    cohortStartTerm: read.readProfile()?.cohortStartTerm ?? null,
    currentTermLabel: resolved.current?.label ?? null,
  });

  return envelope({
    data: {
      term: planningTerm,
      totals: { unitsTaken: tree.units.taken, unitsNeeded: tree.units.needed, unitsRequired: tree.units.required },
      career,
      groups,
    },
    summary: `Faltan ${tree.units.needed ?? '?'} crédito(s) en ${groups.filter((group) => !group.satisfied).length} bloque(s) sin satisfacer.`,
    freshness: read.freshnessFor(['advisement', 'catalog'], { now: now.getTime() }),
    warnings: [],
    unknown: planningTerm
      ? []
      : [{ kind: 'oferta_del_ciclo', reason: 'Sin ciclo de planificación no se puede decir qué materia se oferta.' }],
    now,
  });
}

// ── 6. find_courses ────────────────────────────────────────────────────────

function groupSections(sections) {
  const byCourse = new Map();
  for (const section of sections) {
    const course = byCourse.get(section.code) ?? {
      courseId: section.courseId,
      code: section.code,
      subject: section.subject,
      catalogNbr: section.catalogNbr,
      title: section.title,
      credits: section.credits,
      career: section.career,
      sections: [],
    };
    course.sections.push(section);
    byCourse.set(section.code, course);
  }
  return [...byCourse.values()];
}

function findCourses({ term, codes, query, onlyPending, fitsSchedule, maxResults, now }) {
  const resolved = resolveCycle(now);
  const planningTerm = term ?? resolved.next?.term ?? resolved.current?.term ?? null;
  if (!planningTerm) {
    return envelope({
      data: { term: null, courses: [], totalMatches: 0, truncated: false },
      summary: 'No hay un ciclo de planificación resuelto: pasá el ciclo explícito.',
      freshness: read.freshnessFor(['catalog'], { now: now.getTime() }),
      warnings: [],
      unknown: [{ kind: 'ciclo_de_planificacion', reason: 'Ningún ciclo guardado se resolvió como actual ni próximo.' }],
      now,
    });
  }

  const pending = new Set(read.readPensum().filter((row) => row.status === 'pending').map((row) => row.code));
  const enrolledMeetings = read
    .readEnrollments(read.LOCAL_USER_ID, planningTerm)
    .filter((course) => course.status === 'enrolled')
    .flatMap((course) => course.sections.map((section) => ({ code: course.code, meetings: section.meetings })));

  let courses = groupSections(read.readSections(planningTerm, codes ?? null));
  if (query) {
    const needle = query.toLowerCase();
    courses = courses.filter(
      (course) => course.code.toLowerCase().includes(needle) || (course.title ?? '').toLowerCase().includes(needle)
    );
  }
  if (onlyPending) courses = courses.filter((course) => pending.has(course.code));

  const shaped = courses.map((course) => ({
    code: course.code,
    title: course.title,
    credits: course.credits,
    pendingInPensum: pending.has(course.code),
    sections: course.sections.map((section) => ({
      classNbr: section.classNbr,
      section: section.section,
      component: section.component,
      instructor: section.instructor,
      meetings: section.meetings,
      seats: section.seats,
      // El campus solo sale si la base lo tiene, y siempre con su procedencia.
      // El número de sección NO se usa para deducirlo: esa convención no está
      // publicada y una deducción presentada como dato es un dato inventado.
      campus: section.campus,
      campusSource: section.campusSource,
      campusKnown: section.campusKnown,
      conflictsWith: enrolledMeetings
        .filter((enrolled) => meetingSetsOverlap(enrolled.meetings, section.meetings))
        .map((enrolled) => enrolled.code),
    })),
  }));

  const filtered = fitsSchedule
    ? shaped
        .map((course) => ({ ...course, sections: course.sections.filter((section) => section.conflictsWith.length === 0) }))
        .filter((course) => course.sections.length > 0)
    : shaped;

  const limited = filtered.slice(0, maxResults);

  return envelope({
    data: {
      term: planningTerm,
      courses: limited,
      totalMatches: filtered.length,
      truncated: filtered.length > limited.length,
      campusNote:
        'El campus de una sección solo se conoce si el portal lo escribió; donde campusKnown es false, mikampus no lo sabe.',
    },
    summary: `${filtered.length} materia(s) en ${planningTerm}${filtered.length > limited.length ? `, se devuelven ${limited.length}` : ''}.`,
    freshness: read.freshnessFor(['catalog', 'mySchedule'], { now: now.getTime() }),
    warnings: [],
    unknown: [{ kind: 'prerrequisitos', reason: 'El portal no expone prerrequisitos por materia: mikampus no los conoce.' }],
    now,
  });
}

// ── 7. suggest_load ────────────────────────────────────────────────────────

function suggestLoad({ term, maxCredits, now }) {
  const resolved = resolveCycle(now);
  const planningTerm = term ?? resolved.next?.term ?? resolved.current?.term ?? null;
  if (!planningTerm) {
    return envelope({
      data: null,
      summary: 'No hay un ciclo de planificación resuelto: pasá el ciclo explícito.',
      freshness: read.freshnessFor(['catalog', 'advisement'], { now: now.getTime() }),
      warnings: [],
      unknown: [{ kind: 'ciclo_de_planificacion', reason: 'Ningún ciclo guardado se resolvió como actual ni próximo.' }],
      now,
    });
  }

  const catalog = groupSections(read.readSections(planningTerm)).map((course) => ({
    id: course.courseId,
    code: course.code,
    subject: course.subject,
    catalogNbr: course.catalogNbr,
    title: course.title,
    career: course.career,
    credits: course.credits,
    sections: course.sections.map((section) => ({
      id: section.sectionId,
      term: section.term,
      classNbr: section.classNbr,
      section: section.section,
      component: section.component,
      instructor: section.instructor,
      meetings: section.meetings,
      seats: section.seats
        ? { status: section.seats.status, open: section.seats.open, capacity: section.seats.cap, waitTotal: section.seats.waitTotal }
        : null,
      seatsUpdatedAt: section.seats?.capturedAt ?? null,
    })),
  }));

  const result = recommendCourses({
    requirements: read.readRequirementTree(),
    history: read.readGrades().map((row) => ({ courseCode: row.courseCode, status: row.status })),
    catalog,
    maxCredits,
  });

  return envelope({
    data: { term: planningTerm, ...result },
    summary: `Propuesta de ${result.recommendations.length} materia(s), ${result.totalCredits} crédito(s) de un máximo de ${maxCredits}.`,
    freshness: read.freshnessFor(['catalog', 'advisement', 'grades'], { now: now.getTime() }),
    warnings: [],
    unknown: [{ kind: 'prerrequisitos', reason: 'La propuesta no verifica prerrequisitos: el portal no los expone.' }],
    now,
  });
}

// ── 8, 9, 10 ───────────────────────────────────────────────────────────────

function blockers({ now }) {
  const list = getBlockers({ now });
  return envelope({
    data: { blockers: list },
    summary: list.length === 0 ? 'Nada te está frenando según los datos locales.' : `${list.length} cosa(s) te están frenando. La más urgente: ${list[0].title}.`,
    freshness: read.freshnessFor(ALL_DATASETS, { now: now.getTime() }),
    warnings: [],
    unknown: [],
    now,
  });
}

function upcoming({ horizonDays, now }) {
  const data = getUpcoming({ horizonDays, now });
  return envelope({
    data,
    summary: `${data.items.length} evento(s) en los próximos ${horizonDays} días (revisión ${data.revision}).`,
    freshness: read.freshnessFor(['mySchedule', 'enrollmentWindows'], { now: now.getTime() }),
    warnings: read.termIntegrityWarnings(),
    unknown: [
      { kind: 'modificacion-inscripcion', reason: PORTAL_SILENT_ON },
      { kind: 'retiro-parcial', reason: PORTAL_SILENT_ON },
      { kind: 'retiro-total', reason: PORTAL_SILENT_ON },
      { kind: 'notas', reason: PORTAL_SILENT_ON },
    ],
    now,
  });
}

function activity({ limit, now }) {
  const actions = read.readActionLog(read.LOCAL_USER_ID, limit);
  const syncs = read.readSyncLog(read.LOCAL_USER_ID, limit);
  const merged = [
    ...actions.map((row) => ({
      at: row.createdAt,
      type: 'action',
      what: row.action,
      detail: row.detail,
      result: row.portalResponse,
      ok: row.ok === null ? null : row.ok === 1,
    })),
    ...syncs.map((row) => ({
      at: row.finishedAt,
      type: 'sync',
      what: row.kind,
      detail: row.term,
      result: row.detail ?? `${row.rows ?? 0} fila(s)`,
      ok: row.status === 'ok',
    })),
  ]
    .filter((entry) => entry.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);

  return envelope({
    data: { entries: merged, connection: connectionMode() },
    summary: `${merged.length} evento(s) recientes de mikampus.`,
    freshness: [],
    warnings: [],
    unknown: actions.length === 0 ? [{ kind: 'acciones', reason: 'mikampus nunca ejecutó una acción sobre tu matrícula.' }] : [],
    now,
  });
}

// ── Registro ───────────────────────────────────────────────────────────────
// Cada herramienta declara su propósito en la descripción porque eso es lo que
// el modelo lee para decidir cuándo llamarla; una descripción vaga produce seis
// llamadas y una respuesta mala.

export const READ_TOOLS = [
  {
    name: 'get_overview',
    config: {
      title: 'Cómo voy',
      description:
        'Retrato completo en una sola llamada: carrera y pénsum, ciclo actual y siguiente, materias inscritas con créditos, índice acumulado, créditos que faltan, holds y estado del agente. Empezá por acá en cualquier conversación sobre la carrera de Elias.',
      inputSchema: {},
    },
    run: overview,
  },
  {
    name: 'get_cycle',
    config: {
      title: 'En qué etapa está el ciclo',
      description:
        'Etapa del ciclo académico y qué se puede hacer en ella (inscribir, modificar, dar de baja), con las fechas que el portal publicó y las que no. Las etapas abiertas son varias a la vez, no una: `open` es la lista real y `phase` es solo el título.',
      inputSchema: { term: z.string().optional().describe('Código STRM o etiqueta del ciclo; por defecto el actual') },
    },
    run: ({ term, now }) => cycle({ term: term ?? null, now }),
  },
  {
    name: 'get_schedule',
    config: {
      title: 'Qué tengo hoy o esta semana',
      description:
        'Clases con día, hora y aula, expandidas a fechas concretas dentro de un rango, recortadas contra las fechas reales de cada inscripción. Devuelve también la próxima clase.',
      inputSchema: {
        term: z.string().optional(),
        from: z.string().optional().describe('Fecha ISO YYYY-MM-DD; por defecto hoy'),
        to: z.string().optional().describe('Fecha ISO YYYY-MM-DD; por defecto dentro de 7 días'),
      },
    },
    run: ({ term, from, to, now }) => schedule({ term: term ?? null, from: from ?? null, to: to ?? null, now }),
  },
  {
    name: 'get_academics',
    config: {
      title: 'Cómo van las notas',
      description:
        'Índice acumulado, índice por ciclo, señales sobre el histórico (tendencia, áreas, materias repetidas) y metas de índice con su veredicto y proyección.',
      inputSchema: { includeCourses: z.boolean().optional().describe('Incluir el histórico materia por materia (respuesta grande)') },
    },
    run: ({ includeCourses, now }) => academics({ includeCourses: Boolean(includeCourses), now }),
  },
  {
    name: 'get_degree_progress',
    config: {
      title: 'Qué falta del pénsum',
      description:
        'El árbol de requisitos aplanado a lo accionable: por bloque, qué falta, cuántos créditos y qué materias pendientes se ofertan este ciclo. Incluye el resumen de trayectoria (ciclos restantes, egreso estimado).',
      inputSchema: {
        status: z.enum(['pending', 'all']).optional().describe('Por defecto pending'),
        term: z.string().optional().describe('Ciclo contra el que se mira la oferta'),
      },
    },
    run: ({ status, term, now }) => degreeProgress({ status: status ?? 'pending', term: term ?? null, now }),
  },
  {
    name: 'find_courses',
    config: {
      title: 'Qué puedo inscribir',
      description:
        'Busca materias y secciones del catálogo local de un ciclo, con cupo, horario y el choque contra lo que ya tenés inscrito. El campus solo aparece si el portal lo escribió: no se deduce del número de sección.',
      inputSchema: {
        term: z.string().optional(),
        codes: z.array(z.string()).optional().describe('Códigos canónicos exactos, ej. ICC-303'),
        query: z.string().optional().describe('Texto libre sobre código y título'),
        onlyPending: z.boolean().optional().describe('Solo materias pendientes de tu pénsum'),
        fitsSchedule: z.boolean().optional().describe('Solo secciones que no chocan con tu horario'),
        maxResults: z.number().int().min(1).max(100).optional(),
      },
    },
    run: ({ term, codes, query, onlyPending, fitsSchedule, maxResults, now }) =>
      findCourses({
        term: term ?? null,
        codes: codes ?? null,
        query: query ?? null,
        onlyPending: Boolean(onlyPending),
        fitsSchedule: Boolean(fitsSchedule),
        maxResults: maxResults ?? 25,
        now,
      }),
  },
  {
    name: 'suggest_load',
    config: {
      title: 'Qué debería inscribir',
      description:
        'Propone una combinación de materias para un ciclo drenando primero el período pendiente más viejo del pénsum, con secciones que caben juntas en el horario. No guarda nada ni toca el portal.',
      inputSchema: { term: z.string().optional(), maxCredits: z.number().min(1).max(40).optional() },
    },
    run: ({ term, maxCredits, now }) => suggestLoad({ term: term ?? null, maxCredits: maxCredits ?? 21, now }),
  },
  {
    name: 'get_blockers',
    config: {
      title: 'Qué me está frenando',
      description:
        'Lista rankeada de lo que bloquea a Elias ahora: holds, ventana de inscripción por cerrar, secciones cerradas en el carrito, datos viejos o nunca leídos, agente apagado, inconsistencias de datos.',
      inputSchema: {},
      outputSchema: blockersEnvelopeSchema,
    },
    run: blockers,
  },
  {
    name: 'get_upcoming',
    config: {
      title: 'Qué viene',
      description:
        'Lista plana de fechas próximas (clases, límites de ciclo, apertura y cierre de inscripción, disparos programados) con id estable, precisión y procedencia. Pensada para un gestor de tareas: cuando allDay es true NO hay hora publicada y no se puede poner un recordatorio a hora fija encima.',
      inputSchema: { horizonDays: z.number().int().min(1).max(120).optional().describe('Por defecto 14') },
      outputSchema: upcomingEnvelopeSchema,
    },
    run: ({ horizonDays, now }) => upcoming({ horizonDays: horizonDays ?? 14, now }),
  },
  {
    name: 'get_activity',
    config: {
      title: 'Qué hizo mikampus',
      description:
        'El recibo: acciones que mikampus ejecutó sobre la matrícula con la respuesta literal del portal, más las sincronizaciones, de lo más reciente a lo más viejo.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    run: ({ limit, now }) => activity({ limit: limit ?? 20, now }),
  },
];

// El glosario, como recurso y no como herramienta: se carga una vez por
// conversación y evita que el agente vuelva a adivinar vocabulario en cada
// pregunta.
export const ABOUT_RESOURCE = `# mikampus, para un agente

mikampus es una herramienta local que opera el portal PeopleSoft de PUCMM con la
cuenta del propio estudiante. Todo lo que devuelve sale de una base SQLite local
que un scraper llenó; nada se consulta en vivo al portal desde este servidor.

## Vocabulario

- STRM: el código numérico con que PeopleSoft nombra un ciclo, por ejemplo 1930.
- Etiqueta: el nombre del ciclo en español, por ejemplo "Septiembre de 2026".
  Las dos formas conviven; el identificador que usa la app es el STRM si existe.
- LEC / PRA / LAB: componentes de una misma materia. Una materia inscrita puede
  ocupar dos filas del horario, una por componente.
- Hold: un bloqueo administrativo del portal. severity 'unknown' NO significa
  que no bloquee: significa que el portal no dijo si bloquea.
- precision 'date': el portal publicó una fecha sin hora. No hay hora que citar.

## Lo que mikampus NO sabe

- El campus de una sección del catálogo, salvo que el portal lo haya escrito.
  El número de sección no es una fuente: esa convención no está publicada.
- Los prerrequisitos de una materia: el portal no los expone.
- Las fechas de modificación de inscripción, inscripción tardía, retiro parcial,
  retiro total y publicación de notas, salvo que el estudiante las haya cargado.
  ${PORTAL_SILENT_ON}

## Cómo leer una respuesta

Toda herramienta devuelve asOf, data, freshness, warnings y unknown. Antes de
afirmar algo, mirá freshness (si stale o neverSynced, decilo) y unknown (lo que
está ahí no se sabe y no se estima).
`;
