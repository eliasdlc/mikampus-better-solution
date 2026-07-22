# Security policy

## Supported versions

There is no supported release yet. The current branch is a migration from a
legacy hosted prototype to a local, single-user application. Do not deploy the
legacy hosted configuration.

## Reporting a vulnerability

Do not include credentials, session cookies, academic records, screenshots, or
other personal data in a public issue. Use a private GitHub security advisory
for this repository when it is available; otherwise contact the repository
owner through GitHub and ask for a private reporting channel.

Include a minimal reproduction, affected commit/version, impact, and any safe
mitigation. Reports are acknowledged after a maintainer can review them; no
response-time or bounty commitment is made.

## Scope and handling

High-priority reports include credential disclosure, localhost/LAN request
forgery, arbitrary access to local data, unintended network egress, and supply
chain compromise. Never attach real PUCMM credentials or a raw PeopleSoft page
to a report. Reproduce with the synthetic fixtures and redact diagnostics.
