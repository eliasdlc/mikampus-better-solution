import { DROP_URL } from './constants.js';
import { splitCourseCode, courseCodeToString } from '../shared/courseCode.ts';
import { knownSubjects } from './browseCatalog.js';
import { dropResultSchema } from '../shared/schemas.ts';

function contentFrame(page) {
  return page.frame({ name: 'TargetContent' }) || page.mainFrame();
}

export function extractDropOptions() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim() : '');
  const termCode = (document.documentElement.innerHTML.match(/STRM:"(\d+)"/) ?? [])[1] ?? null;
  const termLabel = (strip(document.querySelector('[id^="DERIVED_REGFRM1_SSR_STDNTKEY_DESCR$"]')).split('|')[0] || '').trim();
  const options = [];
  for (const checkbox of document.querySelectorAll('input[id^="DERIVED_REGFRM1_SSR_SELECT$"][type="checkbox"]')) {
    const i = checkbox.id.split('$').at(-1);
    options.push({
      index: Number(i),
      checkboxId: checkbox.id,
      classLabel: strip(document.getElementById(`R_CLASS_NAME$${i}`)) || strip(checkbox.closest('tr')),
      description: strip(document.getElementById(`P_CLASS_DESCR$${i}`)),
    });
  }
  return { termCode, termLabel: termLabel || null, options };
}

export function parseDropOptions(raw, { subjects = [] } = {}) {
  return raw.options.map((option) => {
    // "ICC ICC233-101 (5225)"
    const match = option.classLabel.match(/^([A-Z0-9-]{1,6})\s+(\S+?)-(\S+?)\s*\((\d+)\)$/);
    const split = match
      ? splitCourseCode(match[2], { subjectHint: match[1], knownSubjects: subjects })
      : null;
    return {
      ...option,
      courseCode: split ? courseCodeToString(split) : null,
      section: match?.[3] ?? null,
      classNbr: match?.[4] ?? null,
    };
  });
}

export function extractDropConfirmation() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim() : '');
  const classes = [];
  for (const el of document.querySelectorAll('[id]')) {
    const match = el.id.match(/^R_CLASS_NAME\$(\d+)$/);
    if (match) classes.push(strip(el));
  }
  return {
    title: strip(document.querySelector('[id="DERIVED_REGFRM1_TITLE1"]')),
    classes,
    hasFinish: !!document.querySelector('input[value="Finish Dropping"]'),
  };
}

export function extractDropResult() {
  const strip = (el) => (el ? el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim() : '');
  const body = strip(document.body);
  const messages = [...document.querySelectorAll('[id*="MESSAGE"], .SSSMESSAGE, .PAPAGEINSTRUCTIONS')]
    .map(strip)
    .filter(Boolean);
  // Solo el status de la fila procesada. La página incluye una LEYENDA con un
  // icono "Dropped" aunque la operación falle; mirar cualquier img produciría
  // un falso éxito en exactamente la acción más delicada de la app.
  const dropped = [...document.querySelectorAll('[id^="win0divDERIVED_REGFRM1_SSR_STATUS_LONG$"] img')].some(
    (img) => /dropped/i.test(`${img.alt} ${img.src}`)
  );
  return { body, messages, dropped };
}

async function chooseTermIfNeeded(page, targetTerm) {
  for (const frame of page.frames()) {
    const radios = frame.locator('input[name^="SSR_DUMMY_RECV1$sels$"]');
    if ((await radios.count().catch(() => 0)) === 0) continue;
    const choices = await frame.evaluate(() =>
      [...document.querySelectorAll('input[name^="SSR_DUMMY_RECV1$sels$"]')].map((radio) => ({
        id: radio.id,
        value: radio.value,
        label: radio.closest('tr')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
      }))
    );
    const choice = choices.find((item) => item.value === targetTerm || item.label.includes(targetTerm));
    if (!choice) throw new Error(`El ciclo ${targetTerm} no está disponible para dar de baja`);
    await frame.locator(`[id="${choice.id}"]`).check();
    const button = frame.locator('input[value="Continue"], input[value="Continuar"]');
    if ((await button.count()) > 0) await button.first().click();
    await page.waitForTimeout(6_000);
    return;
  }
}

export async function dropClass(page, { term, courseCode, classNbr, onStep = () => {} }) {
  onStep(`abriendo la baja de ${courseCode}…`);
  await page.goto(DROP_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(6_000);
  await chooseTermIfNeeded(page, term);

  let frame = contentFrame(page);
  const raw = await frame.evaluate(extractDropOptions);
  if (term && raw.termCode && raw.termCode !== term) {
    throw new Error(`PeopleSoft mostró el ciclo ${raw.termCode}, no el ${term}; no se dio de baja nada`);
  }
  const options = parseDropOptions(raw, { subjects: knownSubjects() });
  const option = options.find(
    (item) => item.courseCode === courseCode && (!classNbr || item.classNbr === String(classNbr))
  );
  if (!option) throw new Error(`${courseCode} no aparece entre las materias que PeopleSoft permite dar de baja`);

  onStep('preparando la confirmación…');
  await frame.locator(`[id="${option.checkboxId}"]`).check();
  await frame.locator('input[value="Drop Selected Classes"]').click();
  await page.waitForTimeout(6_000);
  frame = contentFrame(page);
  const confirmation = await frame.evaluate(extractDropConfirmation);
  if (!confirmation.hasFinish || !confirmation.classes.some((label) => label.includes(option.classNbr))) {
    throw new Error('PeopleSoft no confirmó la misma materia; no se ejecutó la baja');
  }

  onStep(`confirmando la baja de ${courseCode}…`);
  // Único click destructivo. El endpoint solo llega acá después de que la UI
  // exigió escribir el código exacto; withPage lo ejecuta sin retry.
  await frame.locator('input[value="Finish Dropping"]').click();
  await page.waitForTimeout(8_000);
  frame = contentFrame(page);
  const result = await frame.evaluate(extractDropResult);
  const ok = result.dropped || /successfully dropped|drop.*success/i.test(`${result.messages.join(' ')} ${result.body}`);
  const message = result.messages.find((item) => /drop|success|error/i.test(item)) ?? (ok ? 'Baja procesada por PeopleSoft' : 'PeopleSoft no confirmó la baja');
  return dropResultSchema.parse({ ok, courseCode, classLabel: option.classLabel, message });
}
