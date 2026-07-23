import { describe, expect, it } from "vitest"

import { compactSpec, extractOwnedSpec, pruneEmpty } from "@/utils/fieldFilter"

describe("pruneEmpty", () => {
  it("drops null, empty strings, {} and [] but keeps 0 and false", () => {
    expect(
      pruneEmpty({
        replicas: 0,
        paused: false,
        note: null,
        name: "",
        securityContext: {},
        volumes: [],
        image: "nginx",
      }),
    ).toEqual({ replicas: 0, paused: false, image: "nginx" })
  })

  it("prunes recursively and drops subtrees that become empty", () => {
    expect(
      pruneEmpty({
        template: { spec: { securityContext: {}, nodeSelector: {} } },
        strategy: { type: "RollingUpdate" },
      }),
    ).toEqual({ strategy: { type: "RollingUpdate" } })
  })

  it("prunes empties inside arrays", () => {
    expect(pruneEmpty({ items: [{ a: 1, b: {} }, { c: null }] })).toEqual({
      items: [{ a: 1 }],
    })
  })

  // Regression: the accumulator was a plain `{}`, so `out["__proto__"] = …`
  // hit the Object.prototype setter and the field disappeared from the tree
  // (and, with an object value, silently reparented the accumulator).
  it("keeps a field literally named __proto__ as an own key", () => {
    // Object-literal `__proto__:` is the setter too, so the input has to come
    // from JSON — which is where a real one would: the apiserver.
    const input: unknown = JSON.parse('{"__proto__":{"a":1},"keep":2}')
    const pruned = pruneEmpty(input) as Record<string, unknown>
    expect(Object.hasOwn(pruned, "__proto__")).toBe(true)
    expect(Object.keys(pruned).sort()).toEqual(["__proto__", "keep"])
  })
})

describe("extractOwnedSpec", () => {
  it("returns null without a server-side-apply entry owning spec", () => {
    expect(extractOwnedSpec(undefined)).toBeNull()
    // Update-operation ownership is not trusted (round-trips defaults).
    expect(
      extractOwnedSpec([
        { manager: "kubectl-client-side-apply", operation: "Update", fieldsV1: { "f:spec": { "f:replicas": {} } } },
      ]),
    ).toBeNull()
  })

  it("ignores subresource-scoped entries", () => {
    expect(
      extractOwnedSpec([
        {
          manager: "kubectl",
          operation: "Apply",
          subresource: "status",
          fieldsV1: { "f:spec": { "f:x": {} } },
        },
      ]),
    ).toBeNull()
  })

  it("merges spec fieldsets across Apply entries", () => {
    const owned = extractOwnedSpec([
      { manager: "argocd-controller", operation: "Apply", fieldsV1: { "f:spec": { "f:replicas": {} } } },
      { manager: "kube-console", operation: "Apply", fieldsV1: { "f:spec": { "f:paused": {} } } },
      { manager: "kube-controller-manager", operation: "Update", fieldsV1: { "f:status": {} } },
    ])
    expect(owned).toEqual({ "f:replicas": {}, "f:paused": {} })
  })
})

describe("compactSpec via last-applied-configuration", () => {
  const spec = {
    replicas: 3,
    revisionHistoryLimit: 10,
    progressDeadlineSeconds: 600, // default kubectl added — not in the manifest
    template: {
      spec: {
        dnsPolicy: "ClusterFirst", // default — not in the manifest
        schedulerName: "default-scheduler", // default — not in the manifest
        containers: [
          {
            name: "app",
            image: "nginx",
            terminationMessagePath: "/dev/termination-log", // default
            terminationMessagePolicy: "File", // default
            resources: {},
            ports: [{ containerPort: 8080, protocol: "TCP" }],
          },
        ],
      },
    },
  }

  function metaWith(manifestSpec: unknown): { annotations: Record<string, string> } {
    return {
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
          apiVersion: "apps/v1",
          kind: "Deployment",
          spec: manifestSpec,
        }),
      },
    }
  }

  it("keeps only manifest-declared fields and drops defaults", () => {
    const meta = metaWith({
      replicas: 3,
      revisionHistoryLimit: 10,
      template: {
        spec: {
          containers: [{ name: "app", image: "nginx", ports: [{ containerPort: 8080 }] }],
        },
      },
    })
    const { value, filtered, source } = compactSpec(spec, meta)
    expect(filtered).toBe(true)
    expect(source).toBe("last-applied")
    // protocol: TCP was defaulted (the manifest port had only containerPort) → dropped.
    expect(value).toEqual({
      replicas: 3,
      revisionHistoryLimit: 10,
      template: {
        spec: {
          containers: [{ name: "app", image: "nginx", ports: [{ containerPort: 8080 }] }],
        },
      },
    })
  })

  it("matches list elements by merge key, not position", () => {
    const twoContainers = {
      template: {
        spec: {
          containers: [
            { name: "injected-sidecar", image: "istio" }, // added by a webhook, not in manifest
            { name: "app", image: "nginx", imagePullPolicy: "IfNotPresent" },
          ],
        },
      },
    }
    const meta = metaWith({
      template: { spec: { containers: [{ name: "app", image: "nginx" }] } },
    })
    const { value } = compactSpec(twoContainers, meta)
    const containers = (value as { template: { spec: { containers: unknown[] } } }).template.spec
      .containers
    expect(containers).toEqual([{ name: "app", image: "nginx" }])
  })

  // Regression: the manifest lookup used `key in template`, which resolves
  // through Object.prototype. A live field or map key named after a prototype
  // member read as user-declared, and `template[key]` (a function) fell through
  // the type-mismatch branch — keeping exactly the defaults compact mode hides.
  it("does not treat Object.prototype members as manifest-declared fields", () => {
    const live = {
      replicas: 3,
      template: {
        metadata: {
          labels: { app: "web", constructor: "injected", toString: "injected" },
        },
      },
    }
    const meta = metaWith({
      replicas: 3,
      template: { metadata: { labels: { app: "web" } } },
    })
    const { value } = compactSpec(live, meta)
    expect(value).toEqual({ replicas: 3, template: { metadata: { labels: { app: "web" } } } })
  })

  it("shows scalar lists whole", () => {
    const meta = metaWith({ template: { spec: { hostAliases: ["a", "b"] } } })
    const { value } = compactSpec({ template: { spec: { hostAliases: ["a", "b"] } } }, meta)
    expect(value).toEqual({ template: { spec: { hostAliases: ["a", "b"] } } })
  })
})

describe("compactSpec via server-side apply ownership", () => {
  it("keeps only Apply-owned fields when there is no annotation", () => {
    const spec = { replicas: 3, revisionHistoryLimit: 10, paused: false }
    const meta = {
      managedFields: [
        { manager: "kube-console", operation: "Apply", fieldsV1: { "f:spec": { "f:replicas": {} } } },
      ],
    }
    const { value, filtered, source } = compactSpec(spec, meta)
    expect(filtered).toBe(true)
    expect(source).toBe("managed-fields")
    expect(value).toEqual({ replicas: 3 })
  })
})

describe("compactSpec fallbacks", () => {
  it("empty-prunes when no user signal exists (controller-owned)", () => {
    const podSpec = { nodeName: "node-1", securityContext: {}, priority: 0 }
    const meta = { managedFields: [{ manager: "kubelet", operation: "Update", fieldsV1: { "f:status": {} } }] }
    const { value, filtered, source } = compactSpec(podSpec, meta)
    expect(filtered).toBe(false)
    expect(source).toBe("none")
    expect(value).toEqual({ nodeName: "node-1", priority: 0 })
  })

  it("falls back to full spec when filtering hides everything", () => {
    const meta = {
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({ spec: { other: 1 } }),
      },
    }
    const { value, filtered } = compactSpec({ replicas: 2 }, meta)
    expect(filtered).toBe(false)
    expect(value).toEqual({ replicas: 2 })
  })
})
