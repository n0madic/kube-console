package exec

import (
	"errors"
	"fmt"
	"testing"

	// Imported explicitly, by full path, rather than reusing whatever session.go
	// happens to import: that is the whole point of the test. client-go's
	// tools/remotecommand builds its upgrade/proxy errors from this package, so
	// the fallback predicate must recognise these types and no others.
	streamhttpstream "k8s.io/streaming/pkg/httpstream"
)

// Regression: the predicate used to be built on
// k8s.io/apimachinery/pkg/util/httpstream, which declares its own
// UpgradeFailureError. errors.As never matched client-go's, so
// NewFallbackExecutor never fell back and exec silently failed outright against
// any apiserver that cannot serve the WebSocket protocol.
func TestShouldFallbackToSPDYMatchesClientGoErrors(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "upgrade failure",
			err:  &streamhttpstream.UpgradeFailureError{Cause: errors.New("boom")},
			want: true,
		},
		{
			name: "wrapped upgrade failure",
			err:  fmt.Errorf("dial: %w", &streamhttpstream.UpgradeFailureError{Cause: errors.New("boom")}),
			want: true,
		},
		{
			// Matched by message, not by type (gorilla/websocket returns a bare
			// error here); see IsHTTPSProxyError.
			name: "https proxy error",
			err:  errors.New("proxy: unknown scheme: https"),
			want: true,
		},
		{
			name: "unrelated error",
			err:  errors.New("connection refused"),
			want: false,
		},
		{
			name: "nil error",
			err:  nil,
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldFallbackToSPDY(tc.err); got != tc.want {
				t.Fatalf("shouldFallbackToSPDY(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
