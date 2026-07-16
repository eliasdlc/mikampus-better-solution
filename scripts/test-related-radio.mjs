// El paso "Select" del wizard contra HTML real: que la sección relacionada
// exacta se ubique por su class number (contención DOM celda → tr → radio) y
// que un class number ausente devuelva null (→ fallback a la primera, para
// que un práctico lleno no deje la materia fuera del carrito).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { findRelatedSectionRadio } from '../src/peoplesoft/classSearch.js';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(await readFile('fixtures/recon-related-sections.html', 'utf8'));

try {
  const found = await page.evaluate(findRelatedSectionRadio, '1084');
  assert.equal(found, 'SSR_CLS_TBL_R1$sels$0$$0', 'el radio de la fila cuyo RELATE_CLASS_NBR coincide');

  const missing = await page.evaluate(findRelatedSectionRadio, '9999');
  assert.equal(missing, null, 'class number ausente → null (fallback a la primera)');

  console.log('✓ Radio de sección relacionada OK contra HTML real.');
} finally {
  await browser.close();
}
