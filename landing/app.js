const artifactList = document.querySelector('#artifacts');
const status = document.querySelector('#release-status');
const detectedOs = navigator.userAgentData?.platform?.toLowerCase()
  || (navigator.userAgent.includes('Win') ? 'windows' : navigator.userAgent.includes('Mac') ? 'darwin' : 'linux');

function renderArtifact(artifact) {
  const suggested = artifact.os === detectedOs;
  return `<article class="artifact${suggested ? ' suggested' : ''}">
    <p class="artifact-label">${suggested ? 'Sugerido para este equipo' : `${artifact.os} / ${artifact.architecture}`}</p>
    <h3>${artifact.filename}</h3>
    <p>${artifact.requirements}</p>
    <a class="button" href="${artifact.url}">Descargar</a>
    <details><summary>Verificar integridad</summary><code>SHA-256<br>${artifact.sha256}</code></details>
  </article>`;
}

try {
  const response = await fetch('./releases/latest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('No se pudo cargar el manifiesto.');
  const manifest = await response.json();
  if (manifest.status !== 'published') {
    status.textContent = 'Todavía no hay un release público. Consulta el repositorio antes de instalar.';
    artifactList.innerHTML = '<a class="button" href="https://github.com/eliasdlc/mikampus-better-solution">Ver código y documentación</a>';
    return;
  }
  status.innerHTML = `Versión <strong>${manifest.version}</strong> · <a href="${manifest.releaseNotesUrl}">notas del release ↗</a>`;
  artifactList.innerHTML = manifest.artifacts.map(renderArtifact).join('');
} catch {
  status.textContent = 'El manifiesto del release no está disponible. Consulta los releases de GitHub antes de instalar.';
  artifactList.innerHTML = '<a class="button" href="https://github.com/eliasdlc/mikampus-better-solution/releases">Ver releases en GitHub</a>';
}
