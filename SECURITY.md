# Security policy

## Supported versions

Security fixes are made against the latest released version. Older versions may
receive a patch when the same vulnerability can be fixed safely without
changing the host integration contract.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow from the repository Security
tab. If that feature is unavailable, contact the maintainers through a private
channel listed on the repository profile and include only enough information to
establish contact. A maintainer should acknowledge a complete report within
seven days.

Please include:

- affected Agent HUD and host versions;
- operating system and Node.js version;
- reproduction steps and expected impact;
- whether prompts, transcripts, credentials or local paths can be exposed;
- a suggested mitigation, if known.

Do not include real credentials, prompts, transcripts, command output, full
home-directory configuration or unredacted personal paths. Use synthetic
fixtures wherever possible.

## Security boundaries

Agent HUD stores event summaries and caches locally. It must never persist
prompts, command output or tool responses. Configuration writes must remain
atomic, backed up and limited to the selected host. Network access is limited
to the cached Anthropic Statuspage health request.

Reports about an upstream host exposing incorrect telemetry are welcome, but
the upstream host may need to own the final remediation.
