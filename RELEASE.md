# Releasing

Step-by-step for cutting a release of this fork. All packages share one version
(lockstep) — every release bumps everything together.

- `patch` — bug fixes and new features
- `minor` — breaking API changes
- there is no `major` — this repo doesn't do majors

## Prerequisites (one-time machine setup)

- `fd` and `bun` installed locally (`brew install fd`, `brew install oven-sh/bun/bun`)
  — required by the local smoke test in step 2.
- You do **not** need npm publish credentials on your machine. Publishing happens in
  CI via GitHub Actions OIDC trusted publishing — see step 4.

## 1. Audit the changelog

Every package's `CHANGELOG.md` needs an accurate `## [Unreleased]` section before you
release — this becomes the release notes.

Run the `/cl` prompt (if you're driving this from inside `spi`/`pi` itself), or do it
manually:

```bash
git tag --sort=-version:refname | head -1        # last release tag
git log <that-tag>..HEAD --oneline                # everything since
```

Read each package's `[Unreleased]` section and make sure every user-facing change
since the last tag is actually documented there, correctly categorized under
`### Breaking Changes` / `### Added` / `### Changed` / `### Fixed` / `### Removed`.
Don't skip this — it's the only thing that becomes the public release notes.

## 2. Local smoke test

Build an unpublished release and actually run it, from outside the repo so it can't
silently resolve workspace files it shouldn't be able to see:

```bash
npm run release:local -- --out /tmp/pi-local-release --force
cd /tmp

# Node package
/tmp/pi-local-release/node/pi --help
/tmp/pi-local-release/node/pi --version
/tmp/pi-local-release/node/pi --list-models
/tmp/pi-local-release/node/pi -p "Say exactly: ok"
/tmp/pi-local-release/node/pi          # interactive — run in tmux, send a real prompt, wait for a reply

# Bun binary
/tmp/pi-local-release/bun/pi --help
/tmp/pi-local-release/bun/pi --version
/tmp/pi-local-release/bun/pi --list-models
/tmp/pi-local-release/bun/pi -p "Say exactly: ok"
/tmp/pi-local-release/bun/pi           # interactive — same as above
```

Both the Node package and the Bun binary need to pass: help/version print correctly,
models list, a non-interactive prompt gets a real reply, and interactive startup
actually works end to end (not just "the process starts"). Treat any failure here as
a release blocker — don't ship past it without a deliberate, informed decision to
accept the risk.

## 3. Cut the release

```bash
SPI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch
# or, for breaking changes:
SPI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor
```

`npm_config_min_release_age=0` is required only for this command — it bypasses npm's
normal "don't install a package published in the last N minutes" age gate, which
would otherwise block the release lockfile refresh when a workspace package version
was itself just published.

This one command does all of the following automatically:
- bumps every package's version
- finalizes changelogs (moves `[Unreleased]` content under the new version header)
- regenerates release artifacts
- runs `npm run check`
- commits `Release vX.Y.Z`
- tags `vX.Y.Z`
- adds a fresh empty `## [Unreleased]` section to each changelog
- commits `Add [Unreleased] section for next cycle`
- **pushes `main` and the tag directly to `origin`**

That last part is the one deliberate exception to this repo's normal
branch → merge → push convention — review the diff it's about to push before running
this if you have any doubt.

**Do not re-run this command for the same version once the tag has been pushed** —
see the troubleshooting section below for how to recover instead.

## 4. CI takes over

Pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. Watch it:

```bash
gh run watch --exit-status   # or: gh run list --workflow "Build Binaries"
```

It runs, in order:

1. **`build`** — compiles binaries for every platform.
2. **`stage-github-release`** — creates a **draft** GitHub Release with those assets.
   Refuses to run if a release for that tag is already published (see
   troubleshooting).
3. **`publish-npm`** — publishes every package to npm via GitHub Actions OIDC trusted
   publishing. No local `npm publish`, `npm whoami`, OTP, or WebAuthn needed — but see
   troubleshooting if a package fails to publish.
4. **`publish-github-release`** — flips the draft release to published.
5. **`cleanup-draft-github-release`** — deletes the draft if anything above failed, so
   a bad attempt doesn't leave a half-finished release sitting around.

When it's done: check the [Releases page](https://github.com/tculpepp/secure-pi-mono/releases)
and spot-check a package or two with `npm view @tculpepp/spi-coding-agent version`.

## Troubleshooting

**A stray/manual GitHub Release already exists for this tag** — `stage-github-release`
refuses to mutate an already-published release. Delete it and let CI recreate it
properly:
```bash
gh release delete vX.Y.Z --yes --cleanup-tag
```
Then re-run the workflow (see below) rather than the release script.

**`publish-npm` fails with `E404` on a package** — that package's npm Trusted
Publisher isn't configured yet. In npmjs.com's UI, add a Trusted Publisher to the
package with: repo `tculpepp/secure-pi-mono`, workflow `build-binaries.yml`,
environment `npm-publish`. For a **brand-new** package that has never been published
before, OIDC can't establish trust for a package that doesn't exist yet — someone
with real npm credentials needs to run `npm publish --access public` for it once,
manually, before CI can take over.

**Re-running after a CI fix, without cutting a new tag** — a plain tag-push run stays
pinned to the workflow file as it existed at the tagged commit, so a fix landed on
`main` afterward won't take effect on a simple retry. Use `workflow_dispatch` against
`main` instead:
```bash
gh workflow run "Build Binaries" --ref main -f tag=vX.Y.Z
```

**A single job failed but the rest succeeded** — `gh run rerun --failed` re-runs only
the failed jobs. The npm publish step is idempotent (skips versions already on npm),
so this is safe to retry.

**Never** re-run `npm run release:patch` / `release:minor` for a version that's
already been tagged — fix forward via the workflow re-run mechanisms above instead.
