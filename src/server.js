import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { withPage, shutdown } from './session.js';
import { getCartStatus } from './peoplesoft/cart.js';
import { getSearchFormOptions, searchClasses, addClassToCart } from './peoplesoft/classSearch.js';
import * as scheduler from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/cart', async (req, res) => {
  try {
    const rows = await withPage((page) => getCartStatus(page));
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/enroll', async (req, res) => {
  try {
    const result = await scheduler.runEnrollNow('manual');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search/options', async (req, res) => {
  try {
    const options = await withPage((page) => getSearchFormOptions(page));
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { term, career, courseNumber } = req.body;
  if (!term || !career || !courseNumber) {
    return res.status(400).json({ error: 'Faltan term, career o courseNumber' });
  }
  try {
    const rows = await withPage((page) => searchClasses(page, { term, career, courseNumber }));
    res.json({ rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Vuelve a correr la búsqueda para reconstruir el estado exacto de la
// página de resultados y ahí mismo clickear "Select" — así no depende de
// que nada más (el watcher, otra pestaña) haya navegado la sesión
// compartida entremedio de dos llamadas separadas.
app.post('/api/search/add', async (req, res) => {
  const { term, career, courseNumber, classNbr } = req.body;
  if (!term || !career || !courseNumber || !classNbr) {
    return res.status(400).json({ error: 'Faltan term, career, courseNumber o classNbr' });
  }
  try {
    const result = await withPage(async (page) => {
      const rows = await searchClasses(page, { term, career, courseNumber });
      const row = rows.find((r) => r.classNbr === classNbr);
      if (!row) throw new Error('No se encontró esa clase en los resultados de búsqueda');
      if (row.inCart) return { alreadyInCart: true };
      await addClassToCart(page, row.index);
      return { ok: true };
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/state', (req, res) => {
  res.json(scheduler.getState());
});

app.post('/api/schedule', (req, res) => {
  try {
    scheduler.scheduleFixedTime(req.body.atISO);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/schedule', (req, res) => {
  scheduler.cancelSchedule();
  res.json({ ok: true });
});

app.post('/api/watch', (req, res) => {
  const { enabled, intervalMs } = req.body;
  if (enabled) {
    scheduler.startWatcher(intervalMs || 45000);
  } else {
    scheduler.stopWatcher();
  }
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = scheduler.onEvent(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

const PORT = process.env.PORT || 4173;
const server = app.listen(PORT, () => {
  console.log(`pucmm-autoenroll backend en http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await shutdown();
    server.close(() => process.exit(0));
  });
}
