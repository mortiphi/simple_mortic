# Development Setup Checklist

This checklist moves Mortic from prototype development to a controlled branch, CI, and release workflow.

## Branch Model

- `main`: the branch that should become and remain releasable.
- `feature/*`: normal development branches.
- `release/*`: temporary stabilization branches for a release line.
- `vX.Y.Z`: shipped release tags.

Current stabilization branch:

```text
release/0.1-stabilize
```

## Repo Files

- [ ] `.github/workflows/ci.yml` exists and runs on `main`, `release/**`, pull requests, and manual dispatch.
- [ ] `.github/workflows/release-linux.yml` exists and runs on `v*.*.*` tags.
- [ ] `.github/pull_request_template.md` exists.
- [ ] `docs/RELEASE.md` exists.
- [ ] `docs/RELEASE_CRITERIA.md` exists.
- [ ] `CHANGELOG.md` exists.
- [ ] README presents GitHub Release desktop downloads as the first install path.
- [ ] `package.json` and `package-lock.json` are committed together.
- [ ] `.gitignore` ignores generated outputs including `dist/` and `release/`.

## Manual GitHub Settings

Configure branch protection in GitHub:

```text
Settings -> Branches -> Add branch protection rule
```

For `main`:

- [ ] Branch name pattern: `main`
- [ ] Require a pull request before merging.
- [ ] Require status checks to pass.
- [ ] Select `CI / checks` after CI has run at least once.
- [ ] Require branches to be up to date before merging.
- [ ] Require conversation resolution before merging.
- [ ] Block force pushes.
- [ ] Block deletions.

For release branches:

- [ ] Branch name pattern: `release/*`
- [ ] Require a pull request before merging.
- [ ] Require status checks to pass.
- [ ] Select `CI / checks` after CI has run at least once.
- [ ] Require conversation resolution before merging.
- [ ] Block force pushes.
- [ ] Block deletions.

Note: `release/*` is preferred for simple one-level branches such as `release/0.1-stabilize`. Use `release/**` only if release branches become nested, such as `release/linux/0.2`.

## First Stabilization Flow

Use feature branches into `release/0.1-stabilize` until the first release is ready:

```bash
git checkout release/0.1-stabilize
git pull
git checkout -b feature/my-fix
```

Before opening a PR:

```bash
npm run typecheck
npm test
```

After the first release succeeds, merge the stabilization branch back to `main`.

## Release Flow

When the target branch satisfies `docs/RELEASE_CRITERIA.md`:

```bash
npm version patch
git push --follow-tags
```

The tag triggers `.github/workflows/release-linux.yml`, which uploads the Debian package and checksums to GitHub Releases.

Publishing to npm is intentionally deferred. The first public install path is the GitHub Release desktop package.
