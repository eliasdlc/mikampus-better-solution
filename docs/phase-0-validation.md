# Fase 0 — contrato local y auditoría pública

La Fase 0 reemplaza el antiguo piloto hosted. No se abre DNS público, no se
crea infraestructura hosted y no se prueban logins desde un datacenter.

## Gate reproducible

```bash
npm test
npm run typecheck
npm run lint
npm run audit:public
npm run audit:history
```

El primer audit revisa lo que entraría a un commit; el segundo revisa cambios
en toda la historia alcanzable desde ramas locales y remotas sin imprimir los
valores encontrados. Un resultado rojo exige detener releases: se rota cualquier
secreto y se evalúa una reescritura de historia en una operación separada y
autorizada.

El contrato de egress, threat model, disclaimers y política de fixtures viven
en [`local-security.md`](./local-security.md). P2 (nombre/marca) bloquea el
primer package o release.
