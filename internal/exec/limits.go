package exec

import "sync"

// ipGate bounds how many holders one key (a client IP) may have at a time. It
// guards the *handshake* phase only — see Handler.handshakes for why
// established sessions are deliberately not keyed by IP.
//
// A nil gate is disabled and admits everything, so the zero configuration
// stays a no-op without a branch at every call site.
type ipGate struct {
	mu    sync.Mutex
	held  map[string]int
	limit int
}

// newIPGate returns nil when the limit is not positive (disabled).
func newIPGate(limit int) *ipGate {
	if limit <= 0 {
		return nil
	}
	return &ipGate{held: map[string]int{}, limit: limit}
}

// acquire reserves a slot for key, reporting whether one was available.
func (g *ipGate) acquire(key string) bool {
	if g == nil {
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.held[key] >= g.limit {
		return false
	}
	g.held[key]++
	return true
}

// release returns a slot. The key is dropped at zero so the map cannot grow
// with one entry per IP that ever connected.
func (g *ipGate) release(key string) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if n := g.held[key]; n <= 1 {
		delete(g.held, key)
	} else {
		g.held[key] = n - 1
	}
}
