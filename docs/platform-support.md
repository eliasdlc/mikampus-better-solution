# Soporte de plataformas

| Plataforma | Estado | Evidencia |
| --- | --- | --- |
| Linux x64 — Ubuntu 24.04 / Debian 12 | Soportada para RC1 | artifact, install, lifecycle y uninstall smoke en runner Ubuntu nativo |
| Windows x64 | No soportada | falta installer, firma y smoke nativo |
| macOS x64 / ARM64 | No soportada | falta `.app`/DMG, notarización y smoke nativo |
| Linux ARM64 / Windows ARM64 | No soportada | falta build y smoke nativo |

"Compila" no equivale a "soportada". Los releases solo publican la matriz que
pasó installation smoke en runner nativo. El artefacto Linux no está firmado:
verifica SHA-256 y `provenance.json` antes de ejecutarlo.
