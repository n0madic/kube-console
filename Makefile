# The exact tag if HEAD carries one, else the short commit — never plain
# `git describe`, whose v0.1.1-4-gf72a678 form names a release the build is not.
# A build is either a release or a point on a branch, and the sha is what
# identifies the second. `-dirty` marks an uncommitted tree, which only happens
# locally: the Docker build has no .git (.dockerignore) and CI passes VERSION in.
# Simple-expanded so the status walk runs once per make, not per use.
GIT_DIRTY := $(shell test -n "$$(git status --porcelain 2>/dev/null)" && echo -dirty)
VERSION ?= $(shell git describe --tags --exact-match 2>/dev/null \
             || git rev-parse --short=7 HEAD 2>/dev/null || echo dev)$(GIT_DIRTY)
LDFLAGS := -s -w -X main.version=$(VERSION)
# Some npm packages ship Go source (e.g. flatted/golang) without a go.mod, so a
# bare ./... after `npm ci` pulls web/node_modules packages into build/vet/test.
# Deferred (=): resolved only when a Go target actually runs.
GO_PACKAGES = $(shell go list ./... | grep -v '/node_modules/')

.PHONY: all web-install web-build web-test web-typecheck web-lint go-build go-test vet run-dev run-dev-auth docker-build helm-lint verify clean

all: go-build

web-install:
	cd web && npm ci

web-build:
	cd web && npm run build && touch dist/.gitkeep

web-test:
	cd web && npm test

web-typecheck:
	cd web && npx vue-tsc --noEmit

web-lint:
	cd web && npm run lint

go-build: web-build
	go build -trimpath -ldflags '$(LDFLAGS)' -o bin/kube-console ./cmd/kube-console

go-test:
	go test $(GO_PACKAGES) -count=1

vet:
	go vet $(GO_PACKAGES)

run-dev: web-build
	go run ./cmd/kube-console --log-level debug

# Same, but authenticated by the kubeconfig itself: no login screen, no token to
# paste. Loopback-only and kubeconfig-only — the backend refuses to start
# otherwise (see README).
run-dev-auth: web-build
	go run ./cmd/kube-console --log-level debug --listen 127.0.0.1:8080 --use-kubeconfig-credentials

# --build-arg, not just the tag: .git is in .dockerignore, so the build stage
# cannot work the version out for itself and would otherwise embed `dev` in an
# image tagged with the real one.
docker-build:
	docker build --build-arg VERSION=$(VERSION) -t kube-console:$(VERSION) .

helm-lint:
	helm lint deploy/helm/kube-console
	helm template kube-console deploy/helm/kube-console >/dev/null

verify: vet go-test web-lint web-typecheck web-test

clean:
	rm -rf bin web/dist/*
	touch web/dist/.gitkeep
