# Contributing to opapp-desktop

Thanks for helping improve OPApp's desktop host and release tooling.

## License

By contributing to this repository, you agree that your contribution is
provided under the repository's `MPL-2.0` license unless a file or directory
explicitly says otherwise.

## Local setup

1. Install Node.js 24 and enable Corepack.
2. Run `corepack pnpm install`.
3. Use `npm run dev:windows` for the Metro-backed Windows inner loop.
4. Use `npm run verify:windows:dev` for the fast dev check and
   `npm run verify:windows` for the packaged/prod-like result.

## Before opening a pull request

1. Run `npm run commit:check`.
2. If you changed native startup, window/session restore, bundle staging, OTA,
   rollout, packaging, or portable behavior, also run
   `npm run commit:check:release`.
3. Keep changes scoped to this repository unless you are intentionally changing
   a shared contract with `opapp-frontend` or `opapp-mobile`.
4. Confirm you are not committing local registry state, OTA cache state,
   generated artifacts, or credentials.

## Repo boundaries

- Runtime host code, Windows bridges, release verification, and OTA integration
  belong here.
- Default Cloudflare/R2 local env files should stay outside this repo, such as
  the workspace-root `.env.r2.local`.
- Optional private smoke or verify extensions may live under
  `tooling/scripts/.private-*`, but public verification must remain usable
  without them.

## Pull request notes

- Prefer focused PRs with clear runtime, release, or operator impact.
- Call out cross-repo impact when bundle manifests, registry layout, rollout
  fields, or OTA metadata contracts change.
- Include the exact verification commands you ran.

## Community standards

Please follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
