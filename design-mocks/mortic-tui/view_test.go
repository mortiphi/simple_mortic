package main

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
)

func TestRenderedLinesFitTerminalWidth(t *testing.T) {
	tests := []struct {
		name   string
		width  int
		height int
	}{
		{name: "narrow", width: 84, height: 30},
		{name: "medium", width: 112, height: 34},
		{name: "wide", width: 150, height: 42},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			model := initialModel(tt.width, tt.height)
			view := model.render()
			lines := strings.Split(view, "\n")
			if got := len(lines); got > tt.height {
				t.Fatalf("rendered height = %d, want <= %d", got, tt.height)
			}
			for i, line := range lines {
				if got := lipgloss.Width(line); got > tt.width {
					t.Fatalf("line %d width = %d, want <= %d\n%s", i+1, got, tt.width, line)
				}
			}
		})
	}
}

func TestOverlaysFitTerminalWidth(t *testing.T) {
	overlays := []overlayKind{overlayPalette, overlayConfig, overlayTranscript, overlayHandoff}
	for _, overlay := range overlays {
		model := initialModel(120, 36)
		model.overlay = overlay
		view := model.render()
		for i, line := range strings.Split(view, "\n") {
			if got := lipgloss.Width(line); got > model.width {
				t.Fatalf("overlay %d line %d width = %d, want <= %d", overlay, i+1, got, model.width)
			}
		}
	}
}
