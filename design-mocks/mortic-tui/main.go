package main

import (
	"flag"
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"
)

func main() {
	snapshot := flag.Bool("snapshot", false, "render one static frame and exit")
	width := flag.Int("width", 132, "snapshot width")
	height := flag.Int("height", 38, "snapshot height")
	flag.Parse()

	model := initialModel(*width, *height)
	if *snapshot {
		fmt.Println(model.render())
		return
	}

	program := tea.NewProgram(model)
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "mortic tui mockup failed: %v\n", err)
		os.Exit(1)
	}
}
