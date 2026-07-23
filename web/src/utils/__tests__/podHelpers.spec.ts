import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import {
  debugContainerHint,
  defaultContainerName,
  formatCommandLine,
  isMissingExecutableError,
  parseCommandLine,
  podContainers,
} from "@/utils/podHelpers"

function pod(spec: unknown, annotations?: Record<string, string>): K8sObject {
  return { kind: "Pod", metadata: { name: "p", namespace: "ns", annotations }, spec }
}

const threeKinds = pod({
  containers: [{ name: "app" }, { name: "istio-proxy" }],
  initContainers: [{ name: "init-db" }],
  ephemeralContainers: [{ name: "debugger" }],
})

describe("podContainers", () => {
  // Ephemeral before init: a debug container is the usual exec target on an
  // image without a shell, while exec into a finished init container fails.
  it("groups containers, ephemeral ones next, init last", () => {
    expect(podContainers(threeKinds)).toEqual([
      { name: "app", kind: "container" },
      { name: "istio-proxy", kind: "container" },
      { name: "debugger", kind: "ephemeral" },
      { name: "init-db", kind: "init" },
    ])
  })

  it("drops unnamed entries and tolerates a missing spec", () => {
    expect(podContainers(pod({ containers: [{ name: "app" }, {}] }))).toEqual([
      { name: "app", kind: "container" },
    ])
    expect(podContainers({ kind: "Pod" })).toEqual([])
  })
})

describe("defaultContainerName", () => {
  it("honours the kubectl default-container annotation", () => {
    const annotated = pod(threeKinds.spec, {
      "kubectl.kubernetes.io/default-container": "istio-proxy",
    })
    expect(defaultContainerName(annotated)).toBe("istio-proxy")
  })

  // A stale annotation (container renamed) must not select a container that is
  // not in the picker — exec would fail with a confusing 404.
  it("ignores an annotation naming no container of this pod", () => {
    const annotated = pod(threeKinds.spec, {
      "kubectl.kubernetes.io/default-container": "gone",
    })
    expect(defaultContainerName(annotated)).toBe("app")
  })

  it("falls back to the first regular container, then to anything at all", () => {
    expect(defaultContainerName(threeKinds)).toBe("app")
    expect(defaultContainerName(pod({ initContainers: [{ name: "init-db" }] }))).toBe("init-db")
    expect(defaultContainerName({ kind: "Pod" })).toBe("")
  })
})

describe("debugContainerHint", () => {
  it("names the pod and targets the container", () => {
    expect(debugContainerHint("ns", "api-1", "app")).toContain(
      "kubectl debug -it -n ns api-1 --image=busybox --target=app",
    )
  })

  it("omits --target when no container is selected", () => {
    expect(debugContainerHint("ns", "api-1", "")).not.toContain("--target")
  })
})

describe("parseCommandLine", () => {
  it("splits on whitespace", () => {
    expect(parseCommandLine("/bin/bash")).toEqual(["/bin/bash"])
    expect(parseCommandLine("  ls -la /tmp  ")).toEqual(["ls", "-la", "/tmp"])
    expect(parseCommandLine("python3\t-m http.server")).toEqual(["python3", "-m", "http.server"])
  })

  it("returns empty argv for blank input", () => {
    expect(parseCommandLine("")).toEqual([])
    expect(parseCommandLine("   ")).toEqual([])
  })

  // The whole point of quoting here: `sh -c '…'` has to reach exec as three
  // arguments, not as one per word of the script.
  it("keeps a quoted script in a single argument", () => {
    expect(parseCommandLine("/bin/sh -c 'exec bash; echo no'")).toEqual([
      "/bin/sh",
      "-c",
      "exec bash; echo no",
    ])
    expect(parseCommandLine('sh -c "a  b"')).toEqual(["sh", "-c", "a  b"])
  })

  it("escapes with backslashes inside double quotes and outside quotes", () => {
    expect(parseCommandLine('sh -c "say \\"hi\\""')).toEqual(["sh", "-c", 'say "hi"'])
    expect(parseCommandLine('printf a\\ b')).toEqual(["printf", "a b"])
    // Single quotes are literal: no escapes, no nesting.
    expect(parseCommandLine("echo 'a\\b'")).toEqual(["echo", "a\\b"])
  })

  it("keeps an explicitly empty argument and drops nothing else", () => {
    expect(parseCommandLine("sh -c ''")).toEqual(["sh", "-c", ""])
  })

  // A text field is half-typed most of the time; a parse error would be worse
  // than an argument that grows as the closing quote is typed.
  it("ends an unterminated quote at the end of the line", () => {
    expect(parseCommandLine("sh -c 'exec bash")).toEqual(["sh", "-c", "exec bash"])
  })

  // Never a shell: the argv goes to exec, so metacharacters are literal text.
  it("does not expand anything", () => {
    expect(parseCommandLine("echo $HOME *.log")).toEqual(["echo", "$HOME", "*.log"])
  })
})

describe("formatCommandLine", () => {
  it("leaves plain arguments alone and quotes the rest", () => {
    expect(formatCommandLine(["/bin/bash", "-l"])).toBe("/bin/bash -l")
    expect(formatCommandLine(["sh", "-c", "exec bash; exec sh"])).toBe("sh -c 'exec bash; exec sh'")
    expect(formatCommandLine(["sh", "-c", "echo 'hi'"])).toBe('sh -c "echo \'hi\'"')
  })

  // The field shows this rendering and parses back what the user leaves in it,
  // so a preset that did not survive the round trip would silently run as a
  // different command than the one displayed.
  it("round-trips through parseCommandLine", () => {
    for (const argv of [
      ["/bin/sh", "-c", "export TERM=xterm-256color; command -v bash && exec bash; exec sh"],
      ["sh", "-c", 'printf "%s\\n" "a b"'],
      ["echo", "", "a'b", 'c"d', "back\\slash", "tab\there"],
    ]) {
      expect(parseCommandLine(formatCommandLine(argv)), formatCommandLine(argv)).toEqual(argv)
    }
  })
})

describe("isMissingExecutableError", () => {
  it("recognizes missing-binary exec errors", () => {
    for (const msg of [
      'OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/bash": executable file not found in $PATH: unknown',
      "exec: /bin/bash: no such file or directory",
      'command "/bin/bash" not found in PATH',
    ]) {
      expect(isMissingExecutableError(msg), msg).toBe(true)
    }
  })

  it("does not match RBAC or generic errors", () => {
    for (const msg of [
      'pods "api-1" is forbidden: User "jane" cannot create resource "pods/exec"',
      "command terminated with exit code 126",
      "error dialing backend",
    ]) {
      expect(isMissingExecutableError(msg), msg).toBe(false)
    }
  })
})
