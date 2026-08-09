// Merge por campo y procedencia de una sección (P4).
//
// El problema real: dos pantallas del portal describen la misma sección y
// ninguna la describe completa. View My Classes sabe tu horario y tu aula pero
// no publica el profesor; Class Search sí publica el profesor pero no sabe si
// estás inscrito. Como el upsert pisaba campo por campo con lo último que
// llegara, cada sync de horario borraba el profesor que el catálogo había
// enriquecido, y volvía a aparecer recién en el próximo barrido.
//
// La regla es una sola y se aplica por campo: un valor vacío o más pobre nunca
// reemplaza a uno más rico. Además se guarda de dónde salió cada campo, para
// que una discrepancia se pueda ver en vez de resolverse en silencio.

export type SectionSource = 'my-classes' | 'class-search' | 'browse-catalog';

export type Meeting = {
  days: string[];
  start: string | null;
  end: string | null;
  room: string | null;
};

export type SectionFields = {
  section: string | null;
  component: string | null;
  instructor: string | null;
  meetings: Meeting[];
};

export type StoredSection = SectionFields & {
  instructorSource: SectionSource | null;
  meetingsSource: SectionSource | null;
};

export type MergeResult = {
  fields: StoredSection;
  /**
   * Campos donde dos fuentes distintas afirmaron cosas distintas y no vacías.
   * No se resuelve por votación: gana la fuente autoritativa del campo y la
   * discrepancia queda anotada para diagnostics.
   */
  conflicts: Array<{ field: string; kept: string; rejected: string; from: SectionSource; over: SectionSource }>;
};

function blank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

function clean(value: string | null | undefined): string | null {
  if (blank(value)) return null;
  return value!.trim();
}

// Un "TBA" del portal es la forma que tiene PeopleSoft de decir null. Tratarlo
// como dato haría que pisara un aula real.
const PLACEHOLDER = /^(tba|tbd|por (definir|asignar)|sin (aula|asignar))$/i;

function meaningful(value: string | null): string | null {
  const text = clean(value);
  if (!text || PLACEHOLDER.test(text)) return null;
  return text;
}

/**
 * Qué tan informativo es un conjunto de encuentros. Se compara para decidir si
 * lo que llega mejora lo que hay: un horario con aula y hora vale más que uno
 * con los mismos días y todo en TBA.
 */
export function meetingRichness(meetings: Meeting[] | null | undefined): number {
  if (!Array.isArray(meetings) || meetings.length === 0) return 0;
  let score = 0;
  for (const meeting of meetings) {
    score += 1;
    if (meeting.days?.length) score += 1;
    if (meaningful(meeting.start)) score += 1;
    if (meaningful(meeting.end)) score += 1;
    if (meaningful(meeting.room)) score += 2; // el aula es lo que más se busca
  }
  return score;
}

// Quién manda sobre cada campo cuando ambos traen dato. El horario y el aula de
// lo que estás cursando son de View My Classes: es tu matrícula real, no la
// oferta publicada. El profesor y los metadatos de sección son de Class Search,
// que es donde el portal los publica.
const AUTHORITY: Record<string, SectionSource> = {
  meetings: 'my-classes',
  instructor: 'class-search',
};

/**
 * Combina lo que ya está guardado con lo que acaba de llegar.
 *
 * @param existing lo que hay en la base, o null si la sección es nueva
 * @param incoming lo que trajo este scrape
 * @param source   qué pantalla del portal lo trajo
 */
export function mergeSection(
  existing: StoredSection | null,
  incoming: SectionFields,
  source: SectionSource
): MergeResult {
  const conflicts: MergeResult['conflicts'] = [];

  if (!existing) {
    const instructor = meaningful(incoming.instructor);
    const meetings = Array.isArray(incoming.meetings) ? incoming.meetings : [];
    return {
      fields: {
        section: clean(incoming.section),
        component: clean(incoming.component),
        instructor,
        meetings,
        instructorSource: instructor ? source : null,
        meetingsSource: meetings.length ? source : null,
      },
      conflicts: [],
    };
  }

  // ── Texto simple: lo vacío nunca gana ────────────────────────────────────
  const section = clean(incoming.section) ?? existing.section;
  const component = clean(incoming.component) ?? existing.component;

  // ── Profesor ─────────────────────────────────────────────────────────────
  const incomingInstructor = meaningful(incoming.instructor);
  let instructor = existing.instructor;
  let instructorSource = existing.instructorSource;

  if (incomingInstructor) {
    const authoritative = source === AUTHORITY.instructor;
    const existingWasAuthoritative = existing.instructorSource === AUTHORITY.instructor;
    if (!existing.instructor || authoritative || !existingWasAuthoritative) {
      if (existing.instructor && existing.instructor !== incomingInstructor && existing.instructorSource && existing.instructorSource !== source) {
        conflicts.push({
          field: 'instructor',
          kept: incomingInstructor,
          rejected: existing.instructor,
          from: source,
          over: existing.instructorSource,
        });
      }
      instructor = incomingInstructor;
      instructorSource = source;
    } else if (existing.instructor !== incomingInstructor) {
      // Llegó un profesor distinto de una fuente menos autoritativa: se
      // conserva el bueno y se deja constancia de que no coinciden.
      conflicts.push({
        field: 'instructor',
        kept: existing.instructor,
        rejected: incomingInstructor,
        from: existing.instructorSource!,
        over: source,
      });
    }
  }
  // Un incoming vacío no toca nada: es exactamente el caso de View My Classes,
  // que no publica profesor y antes lo borraba en cada sync.

  // ── Encuentros ───────────────────────────────────────────────────────────
  const incomingMeetings = Array.isArray(incoming.meetings) ? incoming.meetings : [];
  const incomingScore = meetingRichness(incomingMeetings);
  const existingScore = meetingRichness(existing.meetings);
  let meetings = existing.meetings;
  let meetingsSource = existing.meetingsSource;

  if (incomingScore > 0) {
    const authoritative = source === AUTHORITY.meetings;
    // La fuente autoritativa gana salvo que traiga MENOS información que lo que
    // ya hay: un View My Classes que devolvió todo en TBA no puede borrar un
    // horario con aulas.
    const wins = existingScore === 0 || incomingScore > existingScore || (authoritative && incomingScore >= existingScore);
    if (wins) {
      meetings = incomingMeetings;
      meetingsSource = source;
    } else if (authoritative === false && existingScore > incomingScore) {
      // Silencio deliberado: que el catálogo tenga menos detalle que tu horario
      // es lo normal, no una discrepancia que valga la pena reportar.
    }
  }

  return {
    fields: { section, component, instructor, meetings, instructorSource, meetingsSource },
    conflicts,
  };
}
