# Guía de releases

Un release se dispara al crear y empujar un tag `vX.Y.Z` cuyo valor coincide con
`package.json`. No publiques desde una máquina local.

El workflow de GitHub Actions instala dependencias bloqueadas, ejecuta tests,
typecheck, lint, scan de secretos/PII, auditoría de npm y smokes de artifact e
instalación en el runner nativo soportado. Después crea primero un GitHub Release
en borrador, publica npm con OIDC provenance y solo entonces adjunta los
artefactos aprobados y publica el release.

Configura el environment protegido `release` con revisión manual y secretos
`VERCEL_TOKEN`, `VERCEL_ORG_ID` y `VERCEL_PROJECT_ID`. npm debe exigir 2FA y
trusted publishing/OIDC para este repositorio. Las Actions de terceros están
fijadas por SHA; al actualizarlas, revisa su origen y actualiza el comentario de
versión. El workflow genera `landing/public/releases/latest.json` desde los
artefactos reales, lo valida y despliega la landing estática en Vercel.

Antes del tag, actualiza las notas de compatibilidad y comprueba que los avisos
de firma son correctos. Después, descarga el asset publicado, verifica el
checksum y prueba instalación/arranque en una máquina limpia cuando sea posible.
No hay publicación si falla un gate. Si la publicación de npm o Vercel falla,
el borrador de GitHub Release permanece como evidencia y se corrige antes de
hacerlo público; no sustituyas assets sin volver a validar el manifiesto.
