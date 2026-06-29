# Mortic TUI Mockup

Charm-native terminal mockup for Mortic's main voice scratch workflow.

This is a static prototype: it does not call Codex, STT/TTS providers, LiveKit,
or Mortic storage. It exists to test layout, interaction rhythm, and visual
direction with the Charm stack.

## Local Go Toolchain

This workspace keeps Go local instead of installing it system-wide. From the
repository root:

```bash
mkdir -p .tools/downloads .tools
curl -L "https://go.dev/dl/go1.26.4.darwin-arm64.tar.gz" -o .tools/downloads/go1.26.4.darwin-arm64.tar.gz
printf "%s  %s\n" "b62ad2b6d7d2464f12a5bcad7ff47f19d08325773b5efd21610e445a05a9bf53" ".tools/downloads/go1.26.4.darwin-arm64.tar.gz" | shasum -a 256 -c -
rm -rf .tools/go
tar -C .tools -xzf .tools/downloads/go1.26.4.darwin-arm64.tar.gz
```

## Run

From this directory:

```bash
PATH="$PWD/../../.tools/go/bin:$PATH" go run .
```

Render a non-interactive snapshot:

```bash
PATH="$PWD/../../.tools/go/bin:$PATH" go run . --snapshot --width 132 --height 38
```

## Test

```bash
PATH="$PWD/../../.tools/go/bin:$PATH" go test ./...
```

## Controls

- `tab`: rotate focus
- `p`: command palette
- `c`: config overlay
- `t`: transcript drawer
- `h`: handoff review
- `r`: simulate turn progress
- `?`: toggle help
- `esc`: close overlay
- `q` or `ctrl+c`: quit

