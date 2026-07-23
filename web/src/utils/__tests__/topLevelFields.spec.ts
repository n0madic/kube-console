import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import { topLevelFields } from "@/utils/topLevelFields"

describe("topLevelFields", () => {
  it("returns null for an object that keeps everything in spec/status", () => {
    const pod: K8sObject = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "nginx" },
      spec: { nodeName: "node-a" },
      status: { phase: "Running" },
    }
    expect(topLevelFields(pod)).toBeNull()
  })

  it("collects an Event's fields outside the skeleton", () => {
    const event = {
      apiVersion: "v1",
      kind: "Event",
      metadata: { name: "nginx.17f", namespace: "prod" },
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 7,
      involvedObject: { kind: "Pod", name: "nginx" },
    } as unknown as K8sObject
    expect(topLevelFields(event)).toEqual({
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container",
      count: 7,
      involvedObject: { kind: "Pod", name: "nginx" },
    })
  })

  it("covers kinds with no spec at all (StorageClass)", () => {
    const sc = {
      apiVersion: "storage.k8s.io/v1",
      kind: "StorageClass",
      metadata: { name: "fast" },
      provisioner: "ebs.csi.aws.com",
      reclaimPolicy: "Delete",
      allowVolumeExpansion: true,
      parameters: { type: "gp3" },
    } as unknown as K8sObject
    expect(topLevelFields(sc)).toEqual({
      provisioner: "ebs.csi.aws.com",
      reclaimPolicy: "Delete",
      allowVolumeExpansion: true,
      parameters: { type: "gp3" },
    })
  })

  it("never repeats what a dedicated panel renders (Secret data stays masked)", () => {
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "tls" },
      type: "kubernetes.io/tls",
      data: { "tls.key": "c2VjcmV0" },
      stringData: { plain: "secret" },
      immutable: true,
    } as unknown as K8sObject
    expect(topLevelFields(secret)).toEqual({ type: "kubernetes.io/tls", immutable: true })
  })

  it("drops empty values but keeps false and 0", () => {
    const object = {
      apiVersion: "v1",
      kind: "Thing",
      metadata: { name: "t" },
      note: "",
      subsets: [],
      related: null,
      count: 0,
      immutable: false,
    } as unknown as K8sObject
    expect(topLevelFields(object)).toEqual({ count: 0, immutable: false })
  })
})
