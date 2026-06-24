# Release Checklist

## Before Release

- Confirm the target branch is green in CI.
- Review changes since the previous release.
- Update `CHANGELOG.md`.
- Confirm README install instructions point to GitHub Release desktop downloads, not npm/npx.
- Run local checks:

```bash
npm ci
npm run typecheck
npm test
npm run dist:linux:dir
npm run dist:linux:deb
```

## Create Release

From the release branch or `main`, choose the right version bump:

```bash
npm version patch
git push --follow-tags
```

Use `npm version minor` or `npm version major` when the release warrants it.

## After Release

- Confirm the GitHub Actions release workflow completed.
- Confirm the GitHub Release exists.
- Confirm the `.deb` and `checksums.txt` assets are attached.
- Download the `.deb` from GitHub and install-test it.
- Launch `mortic-desktop` from the installed package and confirm the app reaches the first-run or session screen.
- From a source build, run `node dist/node/cli/main.js doctor` and confirm the expected Codex/login status.
- Merge release stabilization changes back into `main` if the tag came from a `release/*` branch.

## Branch Rules

- Use `feature/*` branches for normal work.
- Use `release/*` branches only to stabilize a specific release line.
- Tag shipped versions as `vX.Y.Z`.
