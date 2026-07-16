import { CART_URL, CONTENT_FRAME_NAME } from './constants.js';

function contentFrame(page) {
  return page.frame({ name: CONTENT_FRAME_NAME }) || page.mainFrame();
}

// Corre el asistente completo (Step 1 -> 2 -> 3) sobre TODO el carrito.
// PeopleSoft evalúa cada clase de forma independiente aunque el submit sea
// uno solo: las que ya tienen cupo se inscriben, las que siguen llenas
// devuelven "Error: Class X is full" sin ningún efecto secundario. Por eso
// no hace falta seleccionar materias una por una.
export async function enrollFromCart(page) {
  await page.goto(CART_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5000);

  const step1Button = contentFrame(page).locator('input[value="Proceed to Step 2 of 3"]');
  if ((await step1Button.count()) === 0) {
    return { ok: false, reason: 'no-step1-button', results: [] };
  }
  await step1Button.click();
  await page.waitForTimeout(5000);

  const step2Button = contentFrame(page).locator('input[value="Finish Enrolling"]');
  if ((await step2Button.count()) === 0) {
    return { ok: false, reason: 'no-step2-button', results: [] };
  }
  await step2Button.click();
  await page.waitForTimeout(7000);

  const results = await contentFrame(page).evaluate(() => {
    const rows = [];
    for (let i = 0; ; i++) {
      const nameEl = document.getElementById(`R_CLASS_NAME$${i}`);
      if (!nameEl) break;
      const msgEl = document.getElementById(`win0divDERIVED_REGFRM1_SS_MESSAGE_LONG$${i}`);
      const message = msgEl ? msgEl.textContent.trim().replace(/\s+/g, ' ') : '';
      rows.push({
        index: i,
        classLabel: nameEl.textContent.trim().replace(/\s+/g, ' '),
        success: /^Success/i.test(message),
        message,
      });
    }
    return rows;
  });

  return { ok: true, results };
}
