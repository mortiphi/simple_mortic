# Packaging

The first public install path is the desktop package attached to GitHub Releases.

## Build Commands

Build Debian package:

```bash
npm run dist:linux:deb
```

Build unpacked Linux app layout:

```bash
npm run dist:linux:dir
```

Build RPM on a machine with `rpmbuild`:

```bash
npm run dist:linux:rpm
```

Build both package formats:

```bash
npm run dist:linux:all
```

Build macOS Apple Silicon artifacts on a macOS runner:

```bash
npm run dist:mac:arm64
```

Build the Windows multi-arch installer on a Windows runner:

```bash
npm run dist:win
```

Local Linux machines can produce the Debian package. Release-quality macOS artifacts require a macOS runner, and Windows `.exe` artifacts should be produced on the Windows release runner.

## Output

Artifacts are written to:

```text
release/
```

The Linux packages install the desktop app as:

```text
mortic-desktop
```

The Linux build sets Electron's `chrome-sandbox` helper to setuid mode in the packaged app, and the generated Debian/RPM post-install hook configures `/opt/Mortic/chrome-sandbox` for the host sandbox mode.

Verify local Linux artifacts with:

```bash
npm run check:release-artifacts
```
