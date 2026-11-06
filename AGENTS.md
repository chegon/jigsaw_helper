# Project Instructions

## Private infrastructure information

- Treat actual Storage account names, connection strings, keys, Website URLs,
  endpoint hostnames, and values derived from them as sensitive information,
  even when an identifier or URL is publicly reachable.
- Persist those values only in the ignored local `access-key.yaml` selected by
  the deployment configuration. Never copy them into source, README examples,
  tests, build outputs, logs, screenshots, artifacts, commits, or Git history.
- Read private values into memory only when needed. Do not print the private
  configuration, match contents, real URLs, or account names during inspection.
  Report safe file locations and pass/fail results instead.
- Published examples use placeholders. Tests use synthetic data, not a real
  deployment account. Keep `access-key.example.yaml` nonfunctional.
- Do not accept real infrastructure values as command-line overrides or return
  them in deployment summaries; use the local YAML configuration.
- Run `npm run check:privacy` before sharing, committing, or deploying.
  A successful scan without local configuration checks generic patterns only;
  it cannot prove the absence of an unknown account identifier.
- Do not push, rewrite history, or change Azure resources without user approval.
  Changing `.gitignore` does not sanitize existing commits or old clones.

See [README.md](./README.md) for setup, deployment, tests, and limitations.
