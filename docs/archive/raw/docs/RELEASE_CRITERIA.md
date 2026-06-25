# Release Criteria

A Mortic release is ready when:

- `npm ci` works from a clean clone.
- `npm run typecheck` passes.
- `npm test` passes, or failures are documented and explicitly accepted.
- `npm run dist:linux:dir` validates the packaged app layout.
- `npm run dist:linux:deb` produces a Debian package.
- `mortic doctor` works after build.
- The browser app boots with a valid Codex thread.
- The installed desktop app boots from the Debian package.
- README install and run instructions point users to GitHub Releases and the packaged desktop app.
- npm/npx distribution is not required for the first release.
- No secrets or generated release artifacts are committed.

Known exception: canonical-state removal is planned separately. Until that work lands, canonical-state tests are part of the release bar.
