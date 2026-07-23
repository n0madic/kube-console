// Package web embeds the built SPA bundle. It lives outside internal/ because
// go embed cannot reference parent directories — a deliberate deviation from
// the all-code-in-internal layout.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// Dist returns the embedded SPA filesystem rooted at dist/.
func Dist() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
