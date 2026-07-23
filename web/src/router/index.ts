import {
  createRouter,
  createWebHistory,
  type RouteLocationRaw,
  type RouteRecordRaw,
} from "vue-router"

import type { ResourceRef } from "@/api/types"
import { useAuthStore } from "@/stores/auth"
import { CLUSTER_SCOPE_SENTINEL, routeGroup } from "@/utils/k8sNames"

export const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: () => import("@/pages/LoginPage.vue"),
    meta: { public: true },
  },
  { path: "/", redirect: "/overview" },
  {
    path: "/overview",
    name: "overview",
    component: () => import("@/pages/NamespaceOverviewPage.vue"),
  },
  {
    path: "/r/:group/:version/:resource",
    name: "resource-list",
    component: () => import("@/pages/ResourceListPage.vue"),
    props: true,
  },
  {
    path: "/r/:group/:version/:resource/:namespace/:name",
    name: "resource-detail",
    component: () => import("@/pages/ResourceDetailPage.vue"),
    props: true,
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("@/pages/NotFoundPage.vue"),
  },
]

export function createAppRouter() {
  const router = createRouter({
    history: createWebHistory(),
    routes,
  })

  router.beforeEach((to) => {
    const auth = useAuthStore()
    // TTL guard: drop every session past its lifetime, so no expired token is
    // left sitting in sessionStorage. Still-valid sessions for other clusters
    // survive.
    auth.pruneExpiredSessions()
    if (to.meta.public === true) {
      if (auth.isAuthenticated && to.name === "login") return { name: "overview" }
      return true
    }
    if (!auth.isAuthenticated) {
      return { name: "login", query: to.fullPath === "/" ? {} : { redirect: to.fullPath } }
    }
    return true
  })

  return router
}

/** Route to a resource list page. */
export function resourceListRoute(ref: ResourceRef): RouteLocationRaw {
  return {
    name: "resource-list",
    params: { group: routeGroup(ref.group), version: ref.version, resource: ref.resource },
  }
}

/**
 * Route to a resource detail page. Cluster-scoped objects use the "_"
 * namespace sentinel (not a valid DNS-1123 label, so no collisions).
 */
export function resourceDetailRoute(
  ref: ResourceRef,
  namespace: string | undefined,
  name: string,
): RouteLocationRaw {
  return {
    name: "resource-detail",
    params: {
      group: routeGroup(ref.group),
      version: ref.version,
      resource: ref.resource,
      namespace: namespace === undefined || namespace === "" ? CLUSTER_SCOPE_SENTINEL : namespace,
      name,
    },
  }
}
