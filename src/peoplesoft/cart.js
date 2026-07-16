import { CART_URL, CONTENT_FRAME_NAME } from './constants.js';

function contentFrame(page) {
  return page.frame({ name: CONTENT_FRAME_NAME }) || page.mainFrame();
}

// Lee el carrito de inscripción tal cual está hoy: una fila por clase con su
// estado (Open / Closed / Wait List), leído del ícono que PeopleSoft ya
// renderiza — no hace falta interpretar colores de pantalla.
export async function getCartStatus(page) {
  await page.goto(CART_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(5000);

  const frame = contentFrame(page);
  return frame.evaluate(() => {
    // Las filas "atadas" (prácticos ligados a una clase, sin link propio)
    // no tienen <a id="P_CLASS_NAME$N">, solo un <span> deshabilitado dentro
    // del mismo div wrapper — por eso se itera sobre el wrapper, no el link,
    // y se tolera un hueco de índice sin cortar el loop de inmediato.
    const rows = [];
    let consecutiveMisses = 0;
    for (let i = 0; consecutiveMisses < 3; i++) {
      const wrapperEl = document.getElementById(`win0divP_CLASS_NAME$${i}`);
      if (!wrapperEl) {
        consecutiveMisses++;
        continue;
      }
      consecutiveMisses = 0;
      const statusImg = document.querySelector(
        `#win0divDERIVED_REGFRM1_SSR_STATUS_LONG\\$${i} img`
      );
      rows.push({
        index: i,
        classLabel: wrapperEl.textContent.trim().replace(/\s+/g, ' '),
        status: statusImg ? statusImg.alt : null,
      });
    }
    return rows;
  });
}
