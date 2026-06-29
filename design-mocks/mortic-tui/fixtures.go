package main

import "strings"

type scratchItem struct {
	title       string
	desc        string
	status      string
	mode        string
	filterValue string
}

func (i scratchItem) Title() string       { return i.title }
func (i scratchItem) Description() string { return i.desc }
func (i scratchItem) FilterValue() string {
	if i.filterValue != "" {
		return i.filterValue
	}
	return i.title + " " + i.desc + " " + i.status
}

type transcriptEntry struct {
	role  string
	label string
	body  string
	note  string
}

var scratchSessions = []scratchItem{
	{
		title:       "Live voice scratch",
		desc:        "gpt-5.4-mini · none · source untouched",
		status:      "active",
		mode:        "voice",
		filterValue: "live voice scratch active",
	},
	{
		title:  "Latency probe",
		desc:   "Deepgram STT · browser fallback tested",
		status: "ready",
		mode:   "voice",
	},
	{
		title:  "Handoff dry run",
		desc:   "short prompt generated · full prompt pending",
		status: "paused",
		mode:   "text",
	},
	{
		title:  "LiveKit reconnect",
		desc:   "transport recovered · barge-in measured",
		status: "archived",
		mode:   "voice",
	},
}

var transcript = []transcriptEntry{
	{
		role:  "user",
		label: "You",
		body:  "What breaks if LiveKit reconnects during a turn?",
	},
	{
		role:  "assistant",
		label: "Mortic scratch",
		body: strings.TrimSpace(`
The transport can reconnect without touching the source Codex thread, but capture state needs to pause or segment cleanly.

**Read on screen**

- keep scratch fork distinct from the source thread
- drop stale audio if reconnection crosses a turn boundary
- keep interruption latency visible in telemetry
- generate one clean handoff when the scratch is done
`),
		note: "Rendered through Glamour-style markdown inside a viewport.",
	},
	{
		role:  "user",
		label: "You",
		body:  "Mock the TUI but keep the main Mortic palette.",
	},
	{
		role:  "assistant",
		label: "Mortic scratch",
		body: strings.TrimSpace(`
Locked: Charm structure, Mortic colors.

The TUI focuses on voice scratch, transcript, telemetry, settings, and handoff.
`),
	},
}

var handoffMarkdown = strings.TrimSpace(`
# Handoff Preview

Continue the original Codex thread with the voice-scratch findings only.

## Decisions

- Keep the source thread untouched.
- Use the scratch session as disposable working memory.
- Preserve Mortic's cyan/violet dark palette in terminal form.

## Request

Implement the TUI mockup as a faithful Charm-native prototype, not a web dashboard.
`)

var paletteCommands = []string{
	"Start push-to-talk turn",
	"Open config",
	"Open transcript drawer",
	"Generate handoff",
	"Copy short handoff",
	"Reset scratch",
}
