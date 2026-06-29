package main

import (
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/list"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/table"
	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
)

type focusArea int

const (
	focusNav focusArea = iota
	focusScratch
	focusInspector
	focusComposer
)

type overlayKind int

const (
	overlayNone overlayKind = iota
	overlayPalette
	overlayConfig
	overlayTranscript
	overlayHandoff
)

type turnPhase int

const (
	phaseIdle turnPhase = iota
	phaseListening
	phaseTranscribing
	phaseThinking
	phaseSpeaking
)

type progressTickMsg struct{}

type keyMap struct {
	Tab        key.Binding
	BackTab    key.Binding
	Palette    key.Binding
	Config     key.Binding
	Transcript key.Binding
	Handoff    key.Binding
	Simulate   key.Binding
	Help       key.Binding
	Quit       key.Binding
	Close      key.Binding
}

func newKeyMap() keyMap {
	return keyMap{
		Tab:        key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "focus")),
		BackTab:    key.NewBinding(key.WithKeys("shift+tab"), key.WithHelp("S-tab", "back")),
		Palette:    key.NewBinding(key.WithKeys("p", ":"), key.WithHelp("p", "palette")),
		Config:     key.NewBinding(key.WithKeys("c"), key.WithHelp("c", "config")),
		Transcript: key.NewBinding(key.WithKeys("t"), key.WithHelp("t", "transcript")),
		Handoff:    key.NewBinding(key.WithKeys("h"), key.WithHelp("h", "handoff")),
		Simulate:   key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "simulate")),
		Help:       key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "help")),
		Quit:       key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
		Close:      key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "close")),
	}
}

func (k keyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Tab, k.Palette, k.Config, k.Transcript, k.Handoff, k.Simulate, k.Help, k.Quit}
}

func (k keyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Tab, k.BackTab, k.Palette, k.Close},
		{k.Config, k.Transcript, k.Handoff, k.Simulate},
		{k.Help, k.Quit},
	}
}

type AppModel struct {
	width       int
	height      int
	focus       focusArea
	overlay     overlayKind
	turnPhase   turnPhase
	turnPercent float64

	keys     keyMap
	help     help.Model
	spinner  spinner.Model
	progress progress.Model

	nav       NavModel
	scratch   ScratchModel
	inspector InspectorModel
	palette   PaletteModel
	config    ConfigModel
}

type NavModel struct {
	list list.Model
}

type ScratchModel struct {
	viewport viewport.Model
	composer textarea.Model
	rendered string
}

type InspectorModel struct {
	handoff viewport.Model
	table   table.Model
}

type PaletteModel struct {
	cursor int
}

type ConfigModel struct {
	model     string
	reasoning string
	transport string
	stt       string
	tts       string
	caveman   bool
	form      *huh.Form
}

func initialModel(width, height int) AppModel {
	keys := newKeyMap()
	nav := newNavModel()
	scratch := newScratchModel()
	inspector := newInspectorModel()
	config := newConfigModel()

	m := AppModel{
		width:     width,
		height:    height,
		focus:     focusScratch,
		overlay:   overlayNone,
		turnPhase: phaseThinking,
		keys:      keys,
		help:      help.New(),
		spinner: spinner.New(
			spinner.WithSpinner(spinner.Dot),
			spinner.WithStyle(cyanStyle),
		),
		progress: progress.New(
			progress.WithWidth(24),
			progress.WithColors(lipgloss.Color(cyanColor), lipgloss.Color(violetColor)),
			progress.WithoutPercentage(),
		),
		nav:       nav,
		scratch:   scratch,
		inspector: inspector,
		palette:   PaletteModel{},
		config:    config,
	}
	m.setSize(width, height)
	return m
}

func newNavModel() NavModel {
	items := make([]list.Item, 0, len(scratchSessions))
	for _, item := range scratchSessions {
		items = append(items, item)
	}

	delegate := list.NewDefaultDelegate()
	delegate.SetSpacing(1)
	delegate.Styles.NormalTitle = lipgloss.NewStyle().Foreground(lipgloss.Color(inkColor)).PaddingLeft(1)
	delegate.Styles.NormalDesc = lipgloss.NewStyle().Foreground(lipgloss.Color(muted2Color)).PaddingLeft(1)
	delegate.Styles.SelectedTitle = lipgloss.NewStyle().
		Foreground(lipgloss.Color(cyanColor)).
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(lipgloss.Color(cyanColor)).
		PaddingLeft(1).
		Bold(true)
	delegate.Styles.SelectedDesc = lipgloss.NewStyle().
		Foreground(lipgloss.Color(mutedColor)).
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(lipgloss.Color(cyanColor)).
		PaddingLeft(1)
	delegate.Styles.FilterMatch = lipgloss.NewStyle().Foreground(lipgloss.Color(violetColor)).Underline(true)

	l := list.New(items, delegate, 24, 20)
	l.Title = "Scratch sessions"
	l.SetShowHelp(false)
	l.SetShowPagination(false)
	l.SetShowStatusBar(false)
	l.SetShowFilter(false)
	l.SetShowTitle(false)
	l.DisableQuitKeybindings()

	return NavModel{list: l}
}

func newScratchModel() ScratchModel {
	vp := viewport.New(viewport.WithWidth(72), viewport.WithHeight(18))
	ta := textarea.New()
	ta.Placeholder = "Type a scratch turn"
	ta.Prompt = "› "
	ta.ShowLineNumbers = false
	ta.CharLimit = 600
	ta.SetHeight(3)
	ta.SetValue("Mock terminal flow while keeping the main Mortic palette.")
	ta.Blur()
	return ScratchModel{viewport: vp, composer: ta}
}

func newInspectorModel() InspectorModel {
	cols := []table.Column{
		{Title: "stage", Width: 13},
		{Title: "time", Width: 8},
	}
	rows := []table.Row{
		{"received", "0 ms"},
		{"scratch fork", "214 ms"},
		{"first delta", "1.8 s"},
		{"first speech", "2.1 s"},
		{"total", "4.6 s"},
	}
	styles := table.DefaultStyles()
	styles.Header = styles.Header.Foreground(lipgloss.Color(cyanColor)).Bold(true)
	styles.Cell = styles.Cell.Foreground(lipgloss.Color(inkColor))
	styles.Selected = styles.Selected.Foreground(lipgloss.Color(voidColor)).Background(lipgloss.Color(cyanColor)).Bold(true)

	t := table.New(
		table.WithColumns(cols),
		table.WithRows(rows),
		table.WithHeight(7),
		table.WithWidth(28),
		table.WithStyles(styles),
	)
	t.Blur()

	vp := viewport.New(viewport.WithWidth(30), viewport.WithHeight(10))
	return InspectorModel{handoff: vp, table: t}
}

func newConfigModel() ConfigModel {
	cfg := ConfigModel{
		model:     "gpt-5.4-mini",
		reasoning: "none",
		transport: "Local Browser",
		stt:       "Deepgram STT",
		tts:       "Deepgram Aura",
		caveman:   true,
	}
	confirmed := true
	cfg.form = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Model").
				Options(
					huh.NewOption("gpt-5.4-mini", "gpt-5.4-mini"),
					huh.NewOption("gpt-5.4", "gpt-5.4"),
					huh.NewOption("gpt-5.5", "gpt-5.5"),
				).
				Value(&cfg.model),
			huh.NewSelect[string]().
				Title("Reasoning").
				Options(
					huh.NewOption("none", "none"),
					huh.NewOption("low", "low"),
					huh.NewOption("medium", "medium"),
				).
				Value(&cfg.reasoning),
			huh.NewConfirm().
				Title("Caveman speech").
				Affirmative("On").
				Negative("Off").
				Value(&confirmed),
		),
	)
	return cfg
}

func (m AppModel) Init() tea.Cmd {
	return tea.Batch(
		func() tea.Msg { return m.spinner.Tick() },
		nextProgressTick(),
	)
}

func nextProgressTick() tea.Cmd {
	return tea.Tick(900*time.Millisecond, func(time.Time) tea.Msg {
		return progressTickMsg{}
	})
}

func (m AppModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.setSize(msg.Width, msg.Height)
		return m, nil
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	case progressTickMsg:
		m.advanceTurn()
		return m, nextProgressTick()
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	}

	return m.updateFocused(msg)
}

func (m AppModel) View() tea.View {
	view := tea.NewView(m.render())
	view.AltScreen = true
	return view
}

func (m *AppModel) setSize(width, height int) {
	m.width = clamp(width, 78, 180)
	m.height = clamp(height, 24, 60)
	m.help.SetWidth(m.width - 4)

	navW, centerW, inspectorW, bodyH := m.layoutDims()
	m.nav.list.SetSize(max(18, navW-4), max(6, bodyH-11))
	m.scratch.setSize(max(32, centerW-4), max(9, bodyH-11))
	m.inspector.setSize(max(24, inspectorW-4), max(8, bodyH-5))
	m.progress.SetWidth(max(10, min(30, centerW-28)))
}

func (s *ScratchModel) setSize(width, height int) {
	s.rendered = renderTranscript(width)
	s.viewport.SetWidth(width)
	s.viewport.SetHeight(height)
	s.viewport.SetContent(s.rendered)
	s.composer.SetWidth(width - 2)
	s.composer.SetHeight(3)
}

func (i *InspectorModel) setSize(width, height int) {
	i.handoff.SetWidth(width)
	i.handoff.SetHeight(max(5, min(7, height-24)))
	i.handoff.SetContent(renderMarkdown(handoffMarkdown, width))
	i.table.SetWidth(width)
	i.table.SetHeight(7)
}

func (m AppModel) layoutDims() (navW, centerW, inspectorW, bodyH int) {
	bodyH = max(12, m.height-5)
	if m.width < 102 {
		return 0, m.width, 0, bodyH
	}
	navW = clamp(m.width/5, 24, 32)
	inspectorW = clamp(m.width/4, 30, 40)
	centerW = m.width - navW - inspectorW - 2
	return navW, centerW, inspectorW, bodyH
}

func (m AppModel) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if key.Matches(msg, m.keys.Quit) {
		return m, tea.Quit
	}
	if key.Matches(msg, m.keys.Help) {
		m.help.ShowAll = !m.help.ShowAll
		return m, nil
	}
	if m.overlay != overlayNone {
		return m.handleOverlayKey(msg)
	}

	switch {
	case key.Matches(msg, m.keys.Tab):
		m.nextFocus()
		return m, nil
	case key.Matches(msg, m.keys.BackTab):
		m.prevFocus()
		return m, nil
	case key.Matches(msg, m.keys.Palette):
		m.overlay = overlayPalette
		return m, nil
	case key.Matches(msg, m.keys.Config):
		m.overlay = overlayConfig
		return m, nil
	case key.Matches(msg, m.keys.Transcript):
		m.overlay = overlayTranscript
		return m, nil
	case key.Matches(msg, m.keys.Handoff):
		m.overlay = overlayHandoff
		return m, nil
	case key.Matches(msg, m.keys.Simulate):
		m.turnPhase = phaseListening
		m.turnPercent = 0.12
		return m, nil
	}

	return m.updateFocused(msg)
}

func (m AppModel) handleOverlayKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if key.Matches(msg, m.keys.Close) {
		m.overlay = overlayNone
		return m, nil
	}
	if m.overlay == overlayPalette {
		switch msg.String() {
		case "up", "k":
			if m.palette.cursor > 0 {
				m.palette.cursor--
			}
		case "down", "j":
			if m.palette.cursor < len(paletteCommands)-1 {
				m.palette.cursor++
			}
		case "enter":
			switch m.palette.cursor {
			case 1:
				m.overlay = overlayConfig
			case 2:
				m.overlay = overlayTranscript
			case 3, 4:
				m.overlay = overlayHandoff
			default:
				m.overlay = overlayNone
			}
		}
		return m, nil
	}
	if m.overlay == overlayTranscript {
		var cmd tea.Cmd
		m.scratch.viewport, cmd = m.scratch.viewport.Update(msg)
		return m, cmd
	}
	if m.overlay == overlayHandoff {
		var cmd tea.Cmd
		m.inspector.handoff, cmd = m.inspector.handoff.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m AppModel) updateFocused(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch m.focus {
	case focusNav:
		m.nav.list, cmd = m.nav.list.Update(msg)
	case focusScratch:
		m.scratch.viewport, cmd = m.scratch.viewport.Update(msg)
	case focusInspector:
		m.inspector.table.Focus()
		m.inspector.table, cmd = m.inspector.table.Update(msg)
	case focusComposer:
		m.scratch.composer.Focus()
		m.scratch.composer, cmd = m.scratch.composer.Update(msg)
	}
	return m, cmd
}

func (m *AppModel) nextFocus() {
	m.scratch.composer.Blur()
	m.inspector.table.Blur()
	m.focus = (m.focus + 1) % 4
	if m.focus == focusComposer {
		m.scratch.composer.Focus()
	}
	if m.focus == focusInspector {
		m.inspector.table.Focus()
	}
}

func (m *AppModel) prevFocus() {
	m.scratch.composer.Blur()
	m.inspector.table.Blur()
	if m.focus == 0 {
		m.focus = focusComposer
	} else {
		m.focus--
	}
	if m.focus == focusComposer {
		m.scratch.composer.Focus()
	}
	if m.focus == focusInspector {
		m.inspector.table.Focus()
	}
}

func (m *AppModel) advanceTurn() {
	switch m.turnPhase {
	case phaseIdle:
		return
	case phaseListening:
		m.turnPercent += 0.18
		if m.turnPercent >= 0.32 {
			m.turnPhase = phaseTranscribing
		}
	case phaseTranscribing:
		m.turnPercent += 0.16
		if m.turnPercent >= 0.55 {
			m.turnPhase = phaseThinking
		}
	case phaseThinking:
		m.turnPercent += 0.12
		if m.turnPercent >= 0.78 {
			m.turnPhase = phaseSpeaking
		}
	case phaseSpeaking:
		m.turnPercent += 0.10
		if m.turnPercent >= 1 {
			m.turnPhase = phaseIdle
			m.turnPercent = 1
		}
	}
}

func (m AppModel) phaseLabel() string {
	switch m.turnPhase {
	case phaseListening:
		return "listening"
	case phaseTranscribing:
		return "transcribing"
	case phaseThinking:
		return "thinking"
	case phaseSpeaking:
		return "speaking"
	default:
		return "idle"
	}
}

func renderTranscript(width int) string {
	var blocks []string
	for _, entry := range transcript {
		labelStyle := cyanStyle
		bodyStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(inkColor))
		if entry.role == "assistant" {
			labelStyle = violetStyle
			bodyStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(inkColor))
		}
		body := entry.body
		if entry.role == "assistant" {
			body = renderMarkdown(entry.body, max(24, width-4))
		}
		block := labelStyle.Render(entry.label) + "\n" + bodyStyle.Render(body)
		if entry.note != "" {
			block += "\n" + mutedStyle.Render(entry.note)
		}
		blocks = append(blocks, block)
	}
	return strings.Join(blocks, "\n\n")
}

func renderMarkdown(markdown string, width int) string {
	renderer, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle("dark"),
		glamour.WithWordWrap(max(20, width)),
	)
	if err != nil {
		return markdown
	}
	out, err := renderer.Render(markdown)
	if err != nil {
		return markdown
	}
	return strings.TrimSpace(out)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func percentLabel(value float64) string {
	return fmt.Sprintf("%2.0f%%", value*100)
}
