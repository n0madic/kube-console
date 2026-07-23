# Both build stages run on the BUILD platform and cross-compile to the target:
# the SPA is architecture-independent output and the Go binary is CGO-free, so
# GOOS/GOARCH is all it takes. Building natively instead of under QEMU is what
# makes a linux/amd64 + linux/arm64 build cost one compile rather than an
# emulated one — and it is why an amd64 image now builds on an Apple Silicon
# Mac without running Go under Rosetta (which used to crash it).

# Stage 1: build the SPA
FROM --platform=$BUILDPLATFORM node:26-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: build the Go binary with the SPA embedded
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /app/web/dist ./web/dist
ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/kube-console ./cmd/kube-console

# Stage 3: minimal runtime, non-root, no shell
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/kube-console /usr/local/bin/kube-console
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/kube-console"]
