# Política de fixtures y recon

Los fixtures existen para probar parsers sin consultar PUCMM. Deben ser DOM
mínimo y sintético, no una copia de una página de PeopleSoft.

No se versionan contraseñas, cookies, `ICSID`, `ICStateNum`, EMPLID o matrícula,
request IDs, nombres de estudiantes, capturas, diagnósticos ni HTML crudo. Cada
fixture se registra con propósito y revisión en `fixtures/manifest.json`; la
política limita su tamaño y `npm run audit:public` detecta regresiones comunes.

Haz recon solo en tu entorno, sanitiza y reduce el resultado, añade el test que
justifica el fragmento y ejecuta los gates antes de abrir un PR. Un hallazgo real
en historia o HEAD exige revocar el secreto, evaluar su alcance y avisar por el
canal de seguridad; no publiques el valor encontrado.
