package httpx

import "errors"

// ErrShutdown is the cancellation cause AbortOnShutdown attaches when it
// cancels a long-lived request because the server is shutting down.
//
// It exists because a shutdown abort and a departing client are the same
// context.Canceled at the point a handler observes them, and the two need
// opposite responses: a client that is gone must be answered with nothing,
// while a client that is still connected must be told the request failed —
// otherwise net/http completes the response as an empty 200, which a watch
// client reads as a clean end of stream.
//
// Producers cancel with this cause; consumers compare context.Cause(ctx)
// against it.
var ErrShutdown = errors.New("server is shutting down")
