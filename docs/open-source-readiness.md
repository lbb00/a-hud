# Open-source readiness

This checklist separates evidence already proved by the source checkout from
controls that require the canonical GitHub repository or npm publisher
identity. It is the handoff contract for the first public release.

## Proved locally

| Area | Evidence |
| --- | --- |
| Licensing and governance | MIT licenses, contribution guide, code of conduct, security policy, issue forms and pull-request template are present |
| Source quality | Oxlint runs with warnings denied; maintained source and test files are capped at 500 lines |
| Documentation | Local links and Markdown table structure are checked without network access |
| Public packages | Publint validates both tarballs; Are the Types Wrong validates the Provider's ESM and declaration resolution |
| Artifact contents | Package smoke packs both workspaces, rejects top-level source/test directories, installs the tarballs into an isolated consumer, runs the CLI and imports the Provider |
| Runtime compatibility | Published JavaScript is exercised with Node 18; development is tested against the declared Node/npm toolchain |
| Behavior | Provider, setup, renderer, Unicode width, lifecycle, privacy and differential shell-parity tests run through `npm run release:check` |
| Supply chain | The lockfile installs cleanly, install scripts are allowlisted, `npm audit` is clean and GitHub Actions references are full commit SHAs |
| Privacy | Stored event fields are bounded and sanitized; prompts, tool output and responses are excluded; private files are repaired to restrictive modes |
| Release procedure | Versioning, tarball inspection, dry-runs, bundle verification and post-publish checks are documented |

The authoritative local gate is:

```bash
npm ci
npm run release:check
```

## Requires the canonical repository

Complete these items after the upstream URL and owner are known:

1. Initialize Git history, add the canonical remote and confirm the default
   branch.
2. Add `repository`, `homepage` and `bugs` metadata to both published package
   manifests; replace local marketplace examples with canonical clone/install
   links and add badges backed by real checks.
3. Confirm ownership or availability of `agent-hud` and the
   `@agent-hud/provider` npm scope before treating the current names as final.
4. Enable private vulnerability reporting, Dependabot security alerts,
   protected-branch required checks and the full-SHA Actions policy.
5. Run the committed CI workflow on Linux, macOS and Windows. A syntactically
   valid matrix is not evidence that every hosted runner has passed.
6. Configure an environment-protected npm trusted publisher for the canonical
   repository. Do not introduce a long-lived registry token.
7. Add a release workflow pinned to immutable Actions, then require the same
   source, package and Node 18 gates before publication.
8. Publish or install a release candidate from the registry into an empty
   directory and repeat the CLI, Provider and clean-host setup checks.

The first public release is ready only when every item above has repository or
registry evidence. Until then, the source tree is release-prepared but not
published.
