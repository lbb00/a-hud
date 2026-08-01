# Release process

This document prepares releases without assuming a repository owner or npm
publisher identity. Add canonical repository metadata after the upstream URL is
known. The [open-source readiness checklist](open-source-readiness.md)
separates locally proved gates from repository activation work.

## Versioning

`agent-hud` and `@agent-hud/provider` are versioned independently. If provider
behavior changes, update its version and the plugin's workspace dependency. All
four plugin manifests must match the `agent-hud` package version.

Use semantic versioning:

- patch: compatible bug, documentation or packaging fix;
- minor: backward-compatible feature or host support;
- major: public API or observable HUD contract break.

## Prepare

1. Update `CHANGELOG.md`.
2. Update package and plugin manifest versions.
3. Run:

   ```bash
   npm ci
   npm run release:check
   ```

4. Inspect both tarball manifests from the smoke check. Neither package should
   contain top-level tests, TypeScript source files or workspace-only
   configuration.
5. Confirm Publint and Are the Types Wrong report no package or declaration
   errors through `npm run package:lint`.
6. Run all four host setup dry-runs and redact local configuration before
   sharing output.
7. Confirm the committed `plugins/agent-hud/dist` bundle matches a clean build.

## Publish

Publishing requires an npm account authorized for both package names. Enable
two-factor authentication and npm trusted publishing or provenance before the
first release. Publish the provider before a plugin version that depends on it.

Do not add a release workflow containing long-lived registry tokens. Once the
canonical GitHub repository exists, prefer an environment-protected trusted
publisher workflow and require the CI quality gate before tagging.

After publishing:

1. install both packages from the registry into an empty directory;
2. run `agent-hud demo`;
3. verify each marketplace manifest at the tagged commit;
4. create release notes from the changelog;
5. test one clean host installation before announcing the release.
