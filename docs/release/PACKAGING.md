# Packaging

The first public install path is the Linux desktop package attached to GitHub Releases.

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

## Output

Artifacts are written to:

```text
release/
```

The Debian package installs the desktop app as:

```text
mortic-desktop
```

The generated Debian/RPM post-install hook configures Electron's `chrome-sandbox` under `/opt/Mortic`, so users do not need to manually change ownership or mode bits in a project checkout.

