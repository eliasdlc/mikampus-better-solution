const cartTableBody = document.querySelector('#cart-table tbody');
const cartEmpty = document.getElementById('cart-empty');
const connIndicator = document.getElementById('conn-indicator');
const logEl = document.getElementById('log');
const scheduleInput = document.getElementById('schedule-input');
const scheduleStatus = document.getElementById('schedule-status');
const watcherToggle = document.getElementById('watcher-toggle');
const watcherInterval = document.getElementById('watcher-interval');
const watcherStatus = document.getElementById('watcher-status');
const searchTerm = document.getElementById('search-term');
const searchCareer = document.getElementById('search-career');
const searchCourseNbr = document.getElementById('search-course-nbr');
const searchStatus = document.getElementById('search-status');
const searchResultsTable = document.getElementById('search-results-table');
const searchResultsBody = document.querySelector('#search-results-table tbody');

function statusClass(status) {
  if (status === 'Open') return 'status-open';
  if (status === 'Wait List') return 'status-waitlist';
  return 'status-closed';
}

function renderCart(rows) {
  cartTableBody.innerHTML = '';
  cartEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.classLabel}</td>
      <td><span class="status-pill ${statusClass(row.status)}">${row.status ?? '—'}</span></td>
    `;
    cartTableBody.appendChild(tr);
  }
}

function appendLog(text, kind = '') {
  const line = document.createElement('div');
  line.className = `log-line ${kind}`;
  const time = new Date().toLocaleTimeString('es-DO');
  line.textContent = `[${time}] ${text}`;
  logEl.prepend(line);
}

async function refreshCart() {
  appendLog('Consultando carrito...');
  try {
    const res = await fetch('/api/cart');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderCart(data.rows);
  } catch (err) {
    appendLog(`Error consultando carrito: ${err.message}`, 'error');
  }
}

async function loadState() {
  const res = await fetch('/api/state');
  const state = await res.json();
  if (state.schedule) {
    scheduleStatus.textContent = `Programado para ${new Date(state.schedule.atISO).toLocaleString('es-DO')}`;
  }
  if (state.watcher) {
    watcherToggle.checked = true;
    watcherInterval.value = Math.round(state.watcher.intervalMs / 1000);
    watcherStatus.textContent = `Activo (cada ${Math.round(state.watcher.intervalMs / 1000)}s)`;
  }
}

async function loadSearchOptions() {
  searchStatus.textContent = 'Cargando términos y carreras disponibles...';
  try {
    const res = await fetch('/api/search/options');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    searchTerm.innerHTML = data.terms.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
    searchCareer.innerHTML = data.careers
      .map((c) => `<option value="${c.value}" ${c.value === 'GRDO' ? 'selected' : ''}>${c.label}</option>`)
      .join('');
    searchStatus.textContent = 'Elegí término, carrera y el código exacto de la materia.';
  } catch (err) {
    searchStatus.textContent = `Error cargando opciones: ${err.message}`;
  }
}

function renderSearchResults(rows) {
  searchResultsBody.innerHTML = '';
  searchResultsTable.hidden = rows.length === 0;
  if (rows.length === 0) {
    searchStatus.textContent = 'Sin resultados para esos criterios.';
    return;
  }
  searchStatus.textContent = `${rows.length} sección(es) encontradas.`;
  for (const row of rows) {
    const tr = document.createElement('tr');
    const actionCell = row.inCart
      ? '<span class="muted">Ya en el carrito</span>'
      : `<button class="add-to-cart-btn" data-class-nbr="${row.classNbr}">Agregar</button>`;
    tr.innerHTML = `
      <td>${row.classNbr}</td>
      <td>${row.section}</td>
      <td>${row.instructor || '—'}</td>
      <td><span class="status-pill ${statusClass(row.status)}">${row.status ?? '—'}</span></td>
      <td>${actionCell}</td>
    `;
    searchResultsBody.appendChild(tr);
  }
}

document.getElementById('search-btn').addEventListener('click', async () => {
  const courseNumber = searchCourseNbr.value.trim();
  if (!courseNumber) {
    searchStatus.textContent = 'Escribí el código exacto de la materia (ej. ICC321).';
    return;
  }
  searchStatus.textContent = 'Buscando...';
  searchResultsTable.hidden = true;
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: searchTerm.value, career: searchCareer.value, courseNumber }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSearchResults(data.rows);
  } catch (err) {
    searchStatus.textContent = `Error: ${err.message}`;
  }
});

searchResultsBody.addEventListener('click', async (event) => {
  const btn = event.target.closest('.add-to-cart-btn');
  if (!btn) return;
  const classNbr = btn.dataset.classNbr;
  btn.disabled = true;
  btn.textContent = 'Agregando...';
  appendLog(`Agregando clase ${classNbr} al carrito...`);
  try {
    const res = await fetch('/api/search/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        term: searchTerm.value,
        career: searchCareer.value,
        courseNumber: searchCourseNbr.value.trim(),
        classNbr,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.alreadyInCart) {
      appendLog(`${classNbr} ya estaba en el carrito.`);
    } else {
      appendLog(`${classNbr} agregado al carrito.`, 'success');
    }
    btn.closest('tr').querySelector('td:last-child').innerHTML = '<span class="muted">Ya en el carrito</span>';
    refreshCart();
  } catch (err) {
    appendLog(`Error agregando ${classNbr}: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Agregar';
  }
});

document.getElementById('refresh-cart').addEventListener('click', refreshCart);

document.getElementById('enroll-now-btn').addEventListener('click', async () => {
  appendLog('Disparando inscripción manual...');
  try {
    const res = await fetch('/api/enroll', { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    appendLog(`Error: ${err.message}`, 'error');
  }
});

document.getElementById('schedule-btn').addEventListener('click', async () => {
  if (!scheduleInput.value) {
    appendLog('Elegí una fecha/hora primero.', 'error');
    return;
  }
  const atISO = new Date(scheduleInput.value).toISOString();
  const res = await fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ atISO }),
  });
  const data = await res.json();
  if (data.error) appendLog(`Error: ${data.error}`, 'error');
});

document.getElementById('cancel-schedule-btn').addEventListener('click', async () => {
  await fetch('/api/schedule', { method: 'DELETE' });
});

watcherToggle.addEventListener('change', async () => {
  const enabled = watcherToggle.checked;
  const intervalMs = Number(watcherInterval.value) * 1000;
  await fetch('/api/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, intervalMs }),
  });
});

document.getElementById('clear-log').addEventListener('click', () => {
  logEl.innerHTML = '';
});

function connectEvents() {
  const source = new EventSource('/api/events');

  source.onopen = () => {
    connIndicator.textContent = 'conectado';
    connIndicator.className = 'badge badge-on';
  };

  source.onerror = () => {
    connIndicator.textContent = 'reconectando...';
    connIndicator.className = 'badge badge-off';
  };

  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'log':
        appendLog(data.message);
        break;
      case 'cart-status':
        renderCart(data.rows);
        break;
      case 'enroll-result': {
        for (const r of data.results) {
          appendLog(`${r.classLabel}: ${r.message}`, r.success ? 'success' : 'error');
        }
        break;
      }
      case 'schedule-set':
        scheduleStatus.textContent = data.atISO
          ? `Programado para ${new Date(data.atISO).toLocaleString('es-DO')}`
          : 'Sin hora programada.';
        break;
      case 'watcher-set':
        watcherToggle.checked = data.enabled;
        watcherStatus.textContent = data.enabled
          ? `Activo (cada ${Math.round(data.intervalMs / 1000)}s)`
          : 'Desactivado.';
        break;
    }
  };
}

refreshCart();
loadState();
loadSearchOptions();
connectEvents();
