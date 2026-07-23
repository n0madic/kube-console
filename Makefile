VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
# Some npm packages ship Go source (e.g. flatted/golang) without a go.mod, so a
# bare ./... after `npm ci` pulls web/node_modules packages into build/vet/test.
# Deferred (=): resolved only when a Go target actually runs.
GO_PACKAGES = $(shell go list ./... | grep -v '/node_modules/')

.PHONY: all web-install web-build web-test web-typecheck web-lint go-build go-test vet run-dev docker-build helm-lint verify clean

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

docker-build:
	docker build -t kube-console:$(VERSION) .

helm-lint:
	helm lint deploy/helm/kube-console
	helm template kube-console deploy/helm/kube-console >/dev/null

verify: vet go-test web-lint web-typecheck web-test

clean:
	rm -rf bin web/dist/*
	touch web/dist/.gitkeep
