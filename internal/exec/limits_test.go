package exec

import "testing"

func TestIPGateAdmitsUpToTheLimit(t *testing.T) {
	g := newIPGate(2)
	if !g.acquire("1.2.3.4") {
		t.Fatal("the first two acquisitions must succeed")
	}
	if !g.acquire("1.2.3.4") {
		t.Fatal("the first two acquisitions must succeed")
	}
	if g.acquire("1.2.3.4") {
		t.Fatal("the third acquisition must be refused")
	}
	// Another client is unaffected.
	if !g.acquire("5.6.7.8") {
		t.Fatal("a different key must have its own budget")
	}
	g.release("1.2.3.4")
	if !g.acquire("1.2.3.4") {
		t.Fatal("a released slot must be reusable")
	}
}

// Keys are dropped at zero so the map cannot grow by one entry per IP that
// ever connected.
func TestIPGateForgetsIdleKeys(t *testing.T) {
	g := newIPGate(1)
	for i := 0; i < 3; i++ {
		if !g.acquire("1.2.3.4") {
			t.Fatalf("acquire %d failed", i)
		}
		g.release("1.2.3.4")
	}
	if len(g.held) != 0 {
		t.Fatalf("gate retains %d keys, want 0", len(g.held))
	}
}

// An over-release (defensive: the release path is idempotent by construction)
// must not underflow into a negative count that grants free slots forever.
func TestIPGateReleaseWithoutAcquireIsSafe(t *testing.T) {
	g := newIPGate(1)
	g.release("1.2.3.4")
	if !g.acquire("1.2.3.4") {
		t.Fatal("acquire after a stray release must still succeed")
	}
	if g.acquire("1.2.3.4") {
		t.Fatal("the limit must still hold after a stray release")
	}
}

func TestIPGateDisabled(t *testing.T) {
	if got := newIPGate(0); got != nil {
		t.Fatalf("newIPGate(0) = %v, want nil (disabled)", got)
	}
	var g *ipGate
	for i := 0; i < 100; i++ {
		if !g.acquire("1.2.3.4") {
			t.Fatal("a disabled gate must admit everything")
		}
	}
	g.release("1.2.3.4") // must not panic
}
