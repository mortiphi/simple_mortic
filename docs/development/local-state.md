# Local State

Mortic keeps runtime state outside the repo.

## Environment Files

Optional voice/provider keys can be read from:

```text
~/.mortic/.env
repo .env
real environment variables
```

Precedence:

```text
real environment variables > repo .env > ~/.mortic/.env
```

Do not commit `.env` files or secrets.

## Mortic State

```text
~/.mortic/
  sessions/
```

Session folders hold transcripts, handoffs, and session metadata.

## Codex State

```text
~/.codex/
  sessions/
  archived_sessions/
  skills/
```

Vendored Mortic skills are synced into `~/.codex/skills`.
