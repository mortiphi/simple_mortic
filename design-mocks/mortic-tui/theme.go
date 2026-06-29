package main

import (
	"regexp"
	"strings"

	"charm.land/lipgloss/v2"
)

const (
	voidColor   = "#050505"
	headerColor = "#060808"
	bgColor     = "#0a0d0d"
	panelColor  = "#0f1111"
	panel2Color = "#201f1f"
	lineColor   = "#334446"
	lineStrong  = "#88f7ff"
	cyanColor   = "#00f0ff"
	violetColor = "#dcb8ff"
	goldColor   = "#ffd47b"
	redColor    = "#ffb4ab"
	greenColor  = "#98efb0"
	inkColor    = "#e5e2e1"
	inkStrong   = "#fffafa"
	mutedColor  = "#b9cacb"
	muted2Color = "#849495"
)

var (
	ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

	rootStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(inkColor)).
			Background(lipgloss.Color(voidColor))

	topBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(inkColor)).
			Background(lipgloss.Color(headerColor)).
			Border(lipgloss.NormalBorder(), false, false, true, false).
			BorderForeground(lipgloss.Color("#1d2c2f")).
			Padding(0, 1)

	wordmarkStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(inkStrong)).
			Background(lipgloss.Color(headerColor))

	wordmarkDotStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(cyanColor)).
				Background(lipgloss.Color(headerColor))

	headerDividerStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#244247")).
				Background(lipgloss.Color(headerColor))

	headerMetaStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(mutedColor)).
			Background(lipgloss.Color(headerColor))

	headerDimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(muted2Color)).
			Background(lipgloss.Color(headerColor))

	cyanStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(cyanColor)).
			Bold(true)

	violetStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(violetColor)).
			Bold(true)

	mutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(muted2Color))

	softStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(mutedColor))

	okStyle = lipgloss.NewStyle().
		Foreground(lipgloss.Color(greenColor))

	warnStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(goldColor))

	badStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(redColor))

	sectionLabelStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color(muted2Color)).
				Transform(strings.ToUpper).
				Bold(true)

	footerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(mutedColor)).
			Background(lipgloss.Color(bgColor)).
			Border(lipgloss.NormalBorder(), true, false, false, false).
			BorderForeground(lipgloss.Color(lineColor)).
			Padding(0, 1)

	pillStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(inkColor)).
			Background(lipgloss.Color(panel2Color)).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(lineColor)).
			Padding(0, 1)
)

func paneStyle(focused bool) lipgloss.Style {
	borderColor := lineColor
	if focused {
		borderColor = cyanColor
	}

	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(inkColor)).
		Background(lipgloss.Color(panelColor)).
		Border(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1)
}

func overlayBoxStyle(width, height int) lipgloss.Style {
	return lipgloss.NewStyle().
		Width(width).
		Height(height).
		Foreground(lipgloss.Color(inkColor)).
		Background(lipgloss.Color("#070909")).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(cyanColor)).
		Padding(1, 2)
}

func statusDot(color string) string {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render("●")
}

func clamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func padRight(s string, width int) string {
	w := lipgloss.Width(s)
	if w >= width {
		return s
	}
	return s + strings.Repeat(" ", width-w)
}

func fitLine(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= width {
		return padRight(s, width)
	}
	rs := []rune(s)
	for len(rs) > 0 && lipgloss.Width(string(rs)+"…") > width {
		rs = rs[:len(rs)-1]
	}
	return padRight(string(rs)+"…", width)
}

func fitStyledLine(s string, width int) string {
	if lipgloss.Width(s) <= width {
		return padRight(s, width)
	}
	return fitLine(ansiPattern.ReplaceAllString(s, ""), width)
}

func normalizeHeight(s string, height int) string {
	if height <= 0 {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) > height {
		lines = lines[:height]
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}
