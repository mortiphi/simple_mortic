package main

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

func (m AppModel) render() string {
	base := m.renderBase()
	switch m.overlay {
	case overlayPalette:
		return rootStyle.Render(m.placeOverlay(base, m.renderPaletteOverlay()))
	case overlayConfig:
		return rootStyle.Render(m.placeOverlay(base, m.renderConfigOverlay()))
	case overlayTranscript:
		return rootStyle.Render(m.placeOverlay(base, m.renderTranscriptOverlay()))
	case overlayHandoff:
		return rootStyle.Render(m.placeOverlay(base, m.renderHandoffOverlay()))
	default:
		return rootStyle.Render(base)
	}
}

func (m AppModel) renderBase() string {
	navW, centerW, inspectorW, bodyH := m.layoutDims()
	top := m.renderTopBar()
	footer := m.renderFooter()

	var body string
	if m.width < 102 {
		scratchH, inspectorH := narrowPaneHeights(bodyH)
		body = lipgloss.JoinVertical(
			lipgloss.Left,
			renderPane(m.width, scratchH, m.focus == focusScratch, m.renderScratch(centerW-4, scratchH-2)),
			renderPane(m.width, inspectorH, m.focus == focusInspector, m.renderInspector(m.width-4, inspectorH-2)),
		)
	} else {
		body = lipgloss.JoinHorizontal(
			lipgloss.Top,
			renderPane(navW, bodyH, m.focus == focusNav, m.renderNav(navW-4, bodyH-2)),
			verticalGutter(bodyH),
			renderPane(centerW, bodyH, m.focus == focusScratch || m.focus == focusComposer, m.renderScratch(centerW-4, bodyH-2)),
			verticalGutter(bodyH),
			renderPane(inspectorW, bodyH, m.focus == focusInspector, m.renderInspector(inspectorW-4, bodyH-2)),
		)
	}

	return lipgloss.JoinVertical(lipgloss.Left, top, body, footer)
}

func narrowPaneHeights(bodyH int) (scratchH, inspectorH int) {
	inspectorH = clamp(bodyH/4, 5, 7)
	scratchH = bodyH - inspectorH
	if scratchH < 12 {
		scratchH = bodyH - 5
		inspectorH = bodyH - scratchH
	}
	return scratchH, inspectorH
}

func verticalGutter(height int) string {
	lines := make([]string, max(0, height))
	for i := range lines {
		lines[i] = " "
	}
	return strings.Join(lines, "\n")
}

func renderPane(width, height int, focused bool, content string) string {
	if width < 4 || height < 3 {
		return normalizeHeight(content, height)
	}
	innerW := max(1, width-2)
	innerH := max(1, height-2)
	borderColor := lineColor
	if focused {
		borderColor = cyanColor
	}
	borderStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(borderColor))
	border := lipgloss.NormalBorder()
	rows := []string{
		borderStyle.Render(border.TopLeft + strings.Repeat(border.Top, innerW) + border.TopRight),
	}
	for _, line := range strings.Split(normalizeHeight(content, innerH), "\n") {
		rows = append(rows, borderStyle.Render(border.Left)+fitStyledLine(line, innerW)+borderStyle.Render(border.Right))
	}
	rows = append(rows, borderStyle.Render(border.BottomLeft+strings.Repeat(border.Bottom, innerW)+border.BottomRight))
	return strings.Join(rows, "\n")
}

func (m AppModel) renderTopBar() string {
	brand := wordmarkStyle.Render("Mortic") + " " + wordmarkDotStyle.Render("●")

	available := max(20, m.width-4)
	metaParts := []string{
		headerMetaStyle.Render("scratch"),
		statusDot(cyanColor) + " " + headerMetaStyle.Render("live"),
		headerDimStyle.Render(m.config.model),
	}
	if available >= 96 {
		metaParts = []string{
			headerMetaStyle.Render("voice scratch"),
			statusDot(cyanColor) + " " + headerMetaStyle.Render("scratch distinct"),
			statusDot(greenColor) + " " + headerMetaStyle.Render("source untouched"),
			headerDimStyle.Render(m.config.model + " / " + m.config.reasoning),
		}
	}
	if available >= 124 {
		metaParts = []string{
			headerMetaStyle.Render("voice scratch"),
			headerDimStyle.Render("codex://threads/019f...e69"),
			statusDot(cyanColor) + " " + headerMetaStyle.Render("scratch distinct"),
			statusDot(greenColor) + " " + headerMetaStyle.Render("source untouched"),
			headerDimStyle.Render(m.config.model + " / " + m.config.reasoning),
		}
	}
	meta := strings.Join(metaParts, headerDividerStyle.Render("  │  "))
	metaWidth := available - lipgloss.Width(brand) - 3
	line := brand
	if metaWidth > 8 {
		line += " " + headerDividerStyle.Render("│") + " " + fitStyledLine(meta, metaWidth)
	}
	return topBarStyle.Width(m.width - 2).Render(fitStyledLine(line, available))
}

func (m AppModel) renderFooter() string {
	helpView := m.help.View(m.keys)
	if m.help.ShowAll {
		helpView = m.help.FullHelpView(m.keys.FullHelp())
	}
	return footerStyle.Width(m.width - 2).Render(fitLine(helpView, m.width-4))
}

func (m AppModel) renderNav(width, height int) string {
	lines := []string{
		sectionLabelStyle.Render("sessions"),
		softStyle.Render("Scratch history"),
		"",
	}
	selected := m.nav.list.Index()
	for i, item := range scratchSessions {
		cursor := "  "
		titleStyle := softStyle
		descStyle := mutedStyle
		if i == selected {
			cursor = "> "
			titleStyle = cyanStyle
			descStyle = softStyle
		}
		lines = append(lines,
			titleStyle.Render(fitLine(cursor+item.title, width)),
			descStyle.Render(fitLine("  "+item.mode+" · "+item.status, width)),
			"",
		)
	}
	return normalizeHeight(strings.Join(lines, "\n"), height)
}

func (m AppModel) renderScratch(width, height int) string {
	statusRow := cyanStyle.Render(fitLine(strings.Join([]string{
		"transport local",
		"mic " + m.micLabel(),
		"codex " + m.phaseLabel(),
		"speech ready",
	}, "  ·  "), width))

	progressLine := softStyle.Render(m.spinner.View()+" turn ") +
		cyanStyle.Render(m.phaseLabel()) + " " +
		m.progress.ViewAs(m.turnPercent) + " " +
		mutedStyle.Render(percentLabel(m.turnPercent))

	showComposer := height >= 11
	viewportHeight := max(1, height-3)
	if showComposer {
		viewportHeight = max(1, height-8)
	}
	m.scratch.viewport.SetHeight(viewportHeight)
	m.scratch.viewport.SetWidth(width)
	transcriptView := m.scratch.viewport.View()

	composerLabel := sectionLabelStyle.Render("composer") + mutedStyle.Render("  voice/text scratch turn")
	composer := m.scratch.composer.View()

	lines := []string{
		statusRow,
		fitStyledLine(progressLine, width),
		"",
		transcriptView,
	}
	if showComposer {
		lines = append(lines, "", composerLabel, composer)
	}
	return normalizeHeight(strings.Join(lines, "\n"), height)
}

func (m AppModel) renderInspector(width, height int) string {
	if height < 6 {
		lines := []string{
			sectionLabelStyle.Render("handoff"),
			softStyle.Render(fitLine("Short prompt ready", width)),
			fitLine(statusDot(greenColor)+" ready  "+statusDot(cyanColor)+" voice/text fallback", width),
		}
		return normalizeHeight(strings.Join(lines, "\n"), height)
	}
	if height < 12 {
		lines := []string{
			sectionLabelStyle.Render("handoff"),
			softStyle.Render(fitLine("Short prompt ready · full prompt editable", width)),
			"",
			sectionLabelStyle.Render("telemetry"),
			fitLine(mutedStyle.Render("total")+" "+cyanStyle.Render("4.6 s")+"  "+mutedStyle.Render("first speech")+" "+cyanStyle.Render("2.1 s"), width),
			providerLine(width, "mode", "Voice/text fallback", cyanColor),
		}
		return normalizeHeight(strings.Join(lines, "\n"), height)
	}

	providers := []string{
		sectionLabelStyle.Render("handoff"),
		softStyle.Render("Short prompt ready · full prompt editable"),
		m.inspector.handoff.View(),
		"",
		sectionLabelStyle.Render("telemetry"),
		m.inspector.table.View(),
		"",
		sectionLabelStyle.Render("providers"),
		providerLine(width, "transport", "Local Browser", greenColor),
		providerLine(width, "stt", m.config.stt, greenColor),
		providerLine(width, "tts", m.config.tts, greenColor),
		providerLine(width, "mode", "Voice/text fallback", cyanColor),
	}
	return normalizeHeight(strings.Join(providers, "\n"), height)
}

func (m AppModel) micLabel() string {
	switch m.turnPhase {
	case phaseListening:
		return "listening"
	case phaseTranscribing:
		return "finalizing"
	default:
		return "armed"
	}
}

func providerLine(width int, label, value, color string) string {
	return fitLine(mutedStyle.Render(label)+" "+lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render(value), width)
}

func (m AppModel) placeOverlay(base, overlay string) string {
	_ = base
	return lipgloss.Place(
		m.width,
		m.height,
		lipgloss.Center,
		lipgloss.Center,
		overlay,
		lipgloss.WithWhitespaceChars(" "),
		lipgloss.WithWhitespaceStyle(lipgloss.NewStyle().Background(lipgloss.Color(voidColor))),
	)
}

func (m AppModel) renderPaletteOverlay() string {
	width := clamp(m.width-24, 54, 76)
	lines := []string{
		sectionLabelStyle.Render("command palette"),
		softStyle.Render("Charm-style command dispatch for Mortic scratch work"),
		"",
	}
	for i, command := range paletteCommands {
		cursor := "  "
		style := softStyle
		if i == m.palette.cursor {
			cursor = "> "
			style = cyanStyle
		}
		lines = append(lines, style.Render(cursor+command))
	}
	lines = append(lines, "", mutedStyle.Render("enter choose · esc close"))
	return overlayBoxStyle(width, len(lines)+2).Render(strings.Join(lines, "\n"))
}

func (m AppModel) renderConfigOverlay() string {
	width := clamp(m.width-28, 58, 82)
	rows := []string{
		sectionLabelStyle.Render("config"),
		softStyle.Render("Huh-backed settings surface; values are static in the mockup."),
		"",
		configRow("scratch mode", "Voice"),
		configRow("transport", m.config.transport),
		configRow("speech to text", m.config.stt),
		configRow("text to speech", m.config.tts),
		configRow("model", m.config.model),
		configRow("reasoning", m.config.reasoning),
		configRow("caveman speech", "On"),
		"",
		mutedStyle.Render("esc close · production version would run the embedded Huh form"),
	}
	_ = m.config.form
	return overlayBoxStyle(width, len(rows)+2).Render(strings.Join(rows, "\n"))
}

func configRow(label, value string) string {
	return fitLine(mutedStyle.Render(label)+"  "+cyanStyle.Render(value), 64)
}

func (m AppModel) renderTranscriptOverlay() string {
	width := clamp(m.width-18, 68, 110)
	height := clamp(m.height-8, 18, 40)
	content := []string{
		sectionLabelStyle.Render("expanded transcript"),
		softStyle.Render("Scratch-only transcript. Source thread remains clean."),
		"",
	}
	body := m.scratch.viewport.View()
	content = append(content, normalizeHeight(body, height-7))
	content = append(content, "", mutedStyle.Render("j/k scroll · esc close"))
	return overlayBoxStyle(width, height).Render(strings.Join(content, "\n"))
}

func (m AppModel) renderHandoffOverlay() string {
	width := clamp(m.width-18, 68, 108)
	height := clamp(m.height-8, 18, 38)
	rendered := renderMarkdown(handoffMarkdown, width-8)
	lines := []string{
		sectionLabelStyle.Render("handoff review"),
		softStyle.Render("Paste-ready continuation for the original Codex thread."),
		"",
		normalizeHeight(rendered, height-8),
		"",
		cyanStyle.Render("Copy Short") + mutedStyle.Render("  Copy Full  Regenerate  esc close"),
	}
	return overlayBoxStyle(width, height).Render(strings.Join(lines, "\n"))
}

func (f focusArea) String() string {
	switch f {
	case focusNav:
		return "nav"
	case focusScratch:
		return "scratch"
	case focusInspector:
		return "inspector"
	case focusComposer:
		return "composer"
	default:
		return fmt.Sprintf("focus(%d)", f)
	}
}
