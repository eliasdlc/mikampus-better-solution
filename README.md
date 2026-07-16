# pucmm-autoenroll

Dashboard local que automatiza la inscripción en PeopleSoft (Campus Solutions) de PUCMM:

1. **Buscar y agregar materias al carrito** — por término, carrera y código exacto de clase.
2. **Hora fija de pre-matrícula** — dispara el submit del carrito completo justo en el segundo asignado.
3. **Watcher de cupos** — vigila el carrito y en cuanto una materia llena pasa a "Open" se auto-inscribe y notifica.
4. **Inscripción manual** — un botón para correr el asistente de inscripción cuando quieras.

Todo corre sobre una única sesión de Playwright (headless) que el backend mantiene y re-loguea sola si expira.

## Setup

```bash
npm install
npm run install-browsers   # descarga Chromium para Playwright
cp .env.example .env       # completa PUCMM_USERNAME y PUCMM_PASSWORD
npm start                  # levanta el dashboard en http://localhost:4173
```

Abrí `http://localhost:4173` en el navegador. No hace falta build ni tocar nada más — es HTML/CSS/JS plano servido por el mismo Express.

## Cómo funciona por dentro

- `src/login.js` — login contra el signon real de PUCMM.
- `src/session.js` — una sola sesión compartida, en fila (nunca dos acciones de Playwright en paralelo), con reintento de login si expira.
- `src/peoplesoft/cart.js` — lee el carrito y el estado (Open/Closed/Wait List) de cada materia.
- `src/peoplesoft/enroll.js` — corre el asistente de inscripción (Step 1→2→3) sobre todo el carrito y reporta éxito/error por materia.
- `src/peoplesoft/classSearch.js` — busca clases por término/carrera/código y las agrega al carrito, incluyendo los pasos intermedios que PeopleSoft pida (sección relacionada, preferencias de inscripción).
- `src/scheduler.js` — programación a hora fija + watcher periódico, con notificaciones de escritorio (`notify-send`).
- `src/server.js` + `public/` — API REST, Server-Sent Events para actividad en vivo, y el dashboard.

## Riesgos a tener en cuenta

- **Credenciales**: quedan solo en tu `.env` local (gitignored). Nunca las compartas ni las subas a un repo — así fue como le robaron los cupos a un estudiante de Stevens Institute en 2019 al compartir su script con las credenciales adentro.
- **Política institucional**: varias universidades consideran estos bots una forma de saltarse el proceso de inscripción frente a otros estudiantes y han introducido límites de intentos de login o monitoreo tras detectarlos. Vale la pena revisar el reglamento de PUCMM antes de dejarlo corriendo en producción.
- **No sumar carga en el pico**: el intervalo de polling del watcher no debe bajar de los ~30-45s durante la ventana de alta demanda.
- **Selección de sección relacionada**: si una materia tiene varias secciones de práctico disponibles, `addClassToCart` elige la primera que encuentra — no hay todavía forma de elegir manualmente cuál.
