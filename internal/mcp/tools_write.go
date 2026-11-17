package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"
)

// fieldManager names kube-console's MCP writes in managedFields, apart from
// the UI's "kube-console", so ownership says which surface made a change.
const fieldManager = "kube-console-mcp"

// restartAnnotation is the key kubectl rollout restart and the UI both set,
// so the three never fight over separate fields.
const restartAnnotation = "kubectl.kubernetes.io/restartedAt"

// dryRunNote ends every write tool's description: the commit argument is what
// makes a write real, and its zero value is the safe one.
const dryRunNote = " Without commit=true this is a server-side dry run: the apiserver validates and admits " +
	"the change but persists nothing. Run it without commit first, show the user the result, and repeat " +
	"with commit=true only after they confirm."

// restartable is what rollout_restart accepts: the apps/v1 kinds whose pod
// template the restart annotation rolls.
var restartable = map[string]bool{"deployments": true, "statefulsets": true, "daemonsets": true}

// registerWriteTools adds the write tools; registerTools calls it in write mode
// only, so a read-mode tools/list never names them.
func (s *server) registerWriteTools(srv *sdk.Server) {
	addTool(s, srv, &sdk.Tool{
		Name: "apply_manifest",
		Description: "Create or update one object from a YAML or JSON manifest with server-side apply. " +
			"The manifest must hold exactly one object with apiVersion, kind, metadata.name and, for a namespaced " +
			"kind, metadata.namespace. A field owned by another manager (kubectl, a controller, GitOps) is a 409 " +
			"conflict naming that manager. Set force=true only after the user confirms taking ownership of those " +
			"fields: a GitOps controller reverts them on its next sync." + dryRunNote,
		Annotations: destructive("Apply manifest", true),
	}, s.applyManifest)
	addTool(s, srv, &sdk.Tool{
		Name: "delete_resource",
		Description: "Delete one object, with dependents removed in the background like kubectl delete." +
			dryRunNote,
		Annotations: destructive("Delete resource", false),
	}, s.deleteResource)
	addTool(s, srv, &sdk.Tool{
		Name: "scale",
		Description: "Set the replica count of a scalable object (Deployment, StatefulSet, ReplicaSet, or a " +
			"custom resource with a scale subresource) through its scale subresource." + dryRunNote,
		Annotations: destructive("Scale", true),
	}, s.scale)
	addTool(s, srv, &sdk.Tool{
		Name: "rollout_restart",
		Description: "Restart the pods of a Deployment, StatefulSet or DaemonSet by stamping the pod template, " +
			"like kubectl rollout restart." + dryRunNote,
		Annotations: destructive("Rollout restart", false),
	}, s.rolloutRestart)
}

// destructive annotates a write tool. Every one of them can remove or replace
// running state (an apply can drop fields, a scale or restart kills pods), so
// none is marked additive.
func destructive(title string, idempotent bool) *sdk.ToolAnnotations {
	yes := true
	return &sdk.ToolAnnotations{Title: title, DestructiveHint: &yes, IdempotentHint: idempotent}
}

// writeQuery is the query every write sends: dryRun unless committed, and the
// field manager where the verb takes one (DELETE does not).
func writeQuery(commit, manager bool) url.Values {
	q := url.Values{}
	if !commit {
		q.Set("dryRun", "All")
	}
	if manager {
		q.Set("fieldManager", fieldManager)
	}
	return q
}

// objectRef is the part of a returned object a write tool reports.
type objectRef struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name              string  `json:"name"`
		Namespace         string  `json:"namespace"`
		UID               string  `json:"uid"`
		DeletionTimestamp *string `json:"deletionTimestamp"`
	} `json:"metadata"`
}

// --- apply_manifest ---

type applyManifestIn struct {
	Manifest string `json:"manifest" jsonschema:"the object as YAML or JSON; exactly one document"`
	// Force is opt-in, unlike the UI's YAML tab where it is the default: the
	// UI's Apply is a person's own click, while here the conflict is the one
	// signal that a change crosses someone else's fields, and it must reach
	// the user rather than be steamrolled by the model.
	Force  bool `json:"force,omitempty" jsonschema:"true to take ownership of fields other managers own (kubectl apply --force-conflicts); only after the user confirms"`
	Commit bool `json:"commit,omitempty" jsonschema:"true to persist the change; omitted or false is a dry run"`
}

type applyManifestOut struct {
	DryRun bool `json:"dryRun"`
	// Operation is created or updated.
	Operation  string `json:"operation"`
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace,omitempty"`
	Name       string `json:"name"`
	UID        string `json:"uid,omitempty"`
}

// manifestMeta is what apply reads out of a manifest to address it. Every
// field is decoded loosely and checked by hand, so a wrong type is a clear
// error rather than a decode failure naming Go types.
type manifestMeta struct {
	APIVersion any `json:"apiVersion"`
	Kind       any `json:"kind"`
	Metadata   any `json:"metadata"`
}

func (s *server) applyManifest(ctx context.Context, c caller, in applyManifestIn) (applyManifestOut, error) {
	body, err := singleDocument(in.Manifest)
	if err != nil {
		return applyManifestOut{}, err
	}
	var m manifestMeta
	if err := json.Unmarshal(body, &m); err != nil {
		return applyManifestOut{}, errors.New("the manifest must be a single object")
	}
	apiVersion, _ := m.APIVersion.(string)
	kind, _ := m.Kind.(string)
	meta, ok := m.Metadata.(map[string]any)
	if apiVersion == "" || kind == "" || !ok {
		return applyManifestOut{}, errors.New("the manifest needs apiVersion, kind and metadata")
	}
	name, _ := meta["name"].(string)
	if name == "" {
		return applyManifestOut{}, errors.New("metadata.name must be a non-empty string (generateName is not supported)")
	}
	namespace, nsOK := meta["namespace"].(string)
	if _, present := meta["namespace"]; present && !nsOK {
		return applyManifestOut{}, errors.New("metadata.namespace must be a string")
	}
	res, err := resolveKind(ctx, c, apiVersion, kind)
	if err != nil {
		return applyManifestOut{}, err
	}
	switch {
	case res.Namespaced && namespace == "":
		return applyManifestOut{}, fmt.Errorf("%s is namespaced: set metadata.namespace", kind)
	case !res.Namespaced && namespace != "":
		return applyManifestOut{}, fmt.Errorf("%s is cluster-scoped: remove metadata.namespace", kind)
	}
	path, err := target{APIVersion: apiVersion, Resource: res.Name, Namespace: namespace, Name: name}.path()
	if err != nil {
		return applyManifestOut{}, err
	}

	// The body is the manifest as JSON straight out of YAMLToJSON, never a
	// decode/encode round trip: that would turn int64 values past 2^53 into
	// floats. JSON is YAML, so the apply-patch+yaml content type takes it.
	q := writeQuery(in.Commit, true)
	if in.Force {
		q.Set("force", "true")
	}
	respBody, truncated, status, err := send(ctx, c, http.MethodPatch, path, q,
		"application/json", "application/apply-patch+yaml", body, readObjectBytes)
	if err != nil {
		return applyManifestOut{}, err
	}
	out := applyManifestOut{
		DryRun: !in.Commit, Operation: "updated",
		APIVersion: apiVersion, Kind: kind, Namespace: namespace, Name: name,
	}
	if status == http.StatusCreated {
		out.Operation = "created"
	}
	// Only addressing fields are read back: the response is the whole object,
	// Secret data included, and none of it is returned.
	var ref objectRef
	if !truncated && json.Unmarshal(respBody, &ref) == nil {
		out.UID = ref.Metadata.UID
	}
	return out, nil
}

// singleDocument returns the one non-empty document of a YAML (or JSON)
// stream as JSON. A second document is an error rather than silently ignored,
// which is what a plain YAML unmarshal does with it.
func singleDocument(manifest string) ([]byte, error) {
	reader := utilyaml.NewYAMLReader(bufio.NewReader(strings.NewReader(manifest)))
	var found []byte
	for {
		doc, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, errors.New("the manifest is not valid YAML")
		}
		js, err := yaml.YAMLToJSON(doc)
		if err != nil {
			return nil, errors.New("the manifest is not valid YAML")
		}
		if t := bytes.TrimSpace(js); len(t) == 0 || bytes.Equal(t, []byte("null")) {
			continue // a comment-only or empty document, e.g. after a trailing ---
		}
		if found != nil {
			return nil, errors.New("the manifest holds more than one document; apply one object per call")
		}
		found = js
	}
	if found == nil {
		return nil, errors.New("the manifest is empty")
	}
	if found[0] != '{' {
		return nil, errors.New("the manifest must be a single object")
	}
	return found, nil
}

// resolveKind maps a manifest's kind to the resource the URL needs (its plural
// name and scope) from that one group version's APIResourceList — a single
// GET, rather than the whole cluster's catalog, which without aggregated
// discovery is one request per group version and would share the call's
// budget with the PATCH itself.
func resolveKind(ctx context.Context, c caller, apiVersion, kind string) (metav1.APIResource, error) {
	gv, err := groupVersionPath(apiVersion)
	if err == nil {
		gv, err = checkedPath(gv)
	}
	if err != nil {
		return metav1.APIResource{}, err
	}
	notServed := fmt.Errorf("kind %s is not served under %s on this cluster; see list_api_resources", kind, apiVersion)
	var list metav1.APIResourceList
	if err := getJSON(ctx, c, gv, nil, "application/json", readObjectBytes, &list); err != nil {
		var ue *upstreamError
		if errors.As(err, &ue) && ue.code == http.StatusNotFound {
			return metav1.APIResource{}, notServed
		}
		return metav1.APIResource{}, err
	}
	for _, r := range list.APIResources {
		if r.Kind == kind && !strings.Contains(r.Name, "/") { // not a subresource
			return r, nil
		}
	}
	// No list kind is ever served as a resource, so a name ending in List is
	// refused here, by the cluster, and not by a rule that would also refuse
	// an ordinary kind such as AccessList.
	if strings.HasSuffix(kind, "List") {
		return metav1.APIResource{}, errors.New("apply one object at a time, not a list")
	}
	return metav1.APIResource{}, notServed
}

// --- delete_resource ---

type deleteResourceIn struct {
	APIVersion string `json:"apiVersion" jsonschema:"API version: v1 for core resources, or group/version such as apps/v1"`
	Resource   string `json:"resource" jsonschema:"lowercase plural resource name, such as pods or deployments"`
	Namespace  string `json:"namespace,omitempty" jsonschema:"namespace of the object; omit for cluster-scoped resources"`
	Name       string `json:"name" jsonschema:"object name"`
	Commit     bool   `json:"commit,omitempty" jsonschema:"true to delete; omitted or false is a dry run"`
}

type deleteResourceOut struct {
	DryRun bool `json:"dryRun"`
	// Result is deleted, or deletion in progress while finalizers or graceful
	// termination keep the object around.
	Result string `json:"result"`
}

func (s *server) deleteResource(ctx context.Context, c caller, in deleteResourceIn) (deleteResourceOut, error) {
	// An empty name would address the collection, where DELETE removes every
	// object in it.
	if in.Name == "" {
		return deleteResourceOut{}, errors.New("name is required")
	}
	path, err := target{APIVersion: in.APIVersion, Resource: in.Resource, Namespace: in.Namespace, Name: in.Name}.path()
	if err != nil {
		return deleteResourceOut{}, err
	}
	q := writeQuery(in.Commit, false)
	q.Set("propagationPolicy", "Background")
	body, truncated, _, err := send(ctx, c, http.MethodDelete, path, q, "application/json", "", nil, readObjectBytes)
	if err != nil {
		return deleteResourceOut{}, err
	}
	out := deleteResourceOut{DryRun: !in.Commit, Result: "deleted"}
	// The answer is a Status when the object is gone, the object itself when
	// it is still there with a deletionTimestamp.
	var ref objectRef
	if !truncated && json.Unmarshal(body, &ref) == nil && ref.Kind != "Status" && ref.Metadata.DeletionTimestamp != nil {
		out.Result = "deletion in progress"
	}
	return out, nil
}

// --- scale ---

type scaleIn struct {
	APIVersion string `json:"apiVersion" jsonschema:"API version, such as apps/v1"`
	Resource   string `json:"resource" jsonschema:"lowercase plural resource name, such as deployments or statefulsets"`
	Namespace  string `json:"namespace" jsonschema:"namespace of the object"`
	Name       string `json:"name" jsonschema:"object name"`
	// A pointer, so a forgotten replicas is an error instead of a zero that
	// would scale the workload away.
	Replicas *int64 `json:"replicas" jsonschema:"desired replica count; 0 scales to zero"`
	Commit   bool   `json:"commit,omitempty" jsonschema:"true to persist the change; omitted or false is a dry run"`
}

type scaleOut struct {
	DryRun bool `json:"dryRun"`
	// Replicas is the desired count as the scale subresource now reports it.
	Replicas int64 `json:"replicas"`
	// CurrentReplicas is how many replicas exist right now.
	CurrentReplicas int64 `json:"currentReplicas"`
}

func (s *server) scale(ctx context.Context, c caller, in scaleIn) (scaleOut, error) {
	if in.Replicas == nil {
		return scaleOut{}, errors.New("replicas is required")
	}
	if *in.Replicas < 0 || *in.Replicas > math.MaxInt32 {
		return scaleOut{}, errors.New("replicas must be between 0 and 2147483647")
	}
	if in.Name == "" {
		return scaleOut{}, errors.New("name is required")
	}
	path, err := target{APIVersion: in.APIVersion, Resource: in.Resource, Namespace: in.Namespace, Name: in.Name, Subresource: "scale"}.path()
	if err != nil {
		return scaleOut{}, err
	}
	patch := fmt.Appendf(nil, `{"spec":{"replicas":%d}}`, *in.Replicas)
	body, truncated, _, err := send(ctx, c, http.MethodPatch, path, writeQuery(in.Commit, true),
		"application/json", "application/merge-patch+json", patch, readObjectBytes)
	if err != nil {
		return scaleOut{}, err
	}
	var sc struct {
		Spec struct {
			Replicas int64 `json:"replicas"`
		} `json:"spec"`
		Status struct {
			Replicas int64 `json:"replicas"`
		} `json:"status"`
	}
	if truncated || json.Unmarshal(body, &sc) != nil {
		return scaleOut{}, errors.New("unexpected response from kube-apiserver")
	}
	return scaleOut{DryRun: !in.Commit, Replicas: sc.Spec.Replicas, CurrentReplicas: sc.Status.Replicas}, nil
}

// --- rollout_restart ---

type rolloutRestartIn struct {
	Resource  string `json:"resource" jsonschema:"deployments, statefulsets or daemonsets (apps/v1)"`
	Namespace string `json:"namespace" jsonschema:"namespace of the object"`
	Name      string `json:"name" jsonschema:"object name"`
	Commit    bool   `json:"commit,omitempty" jsonschema:"true to restart; omitted or false is a dry run"`
}

type rolloutRestartOut struct {
	DryRun      bool   `json:"dryRun"`
	RestartedAt string `json:"restartedAt"`
}

func (s *server) rolloutRestart(ctx context.Context, c caller, in rolloutRestartIn) (rolloutRestartOut, error) {
	if !restartable[in.Resource] {
		return rolloutRestartOut{}, errors.New("resource must be deployments, statefulsets or daemonsets")
	}
	if in.Namespace == "" || in.Name == "" {
		return rolloutRestartOut{}, errors.New("namespace and name are required")
	}
	path, err := target{APIVersion: "apps/v1", Resource: in.Resource, Namespace: in.Namespace, Name: in.Name}.path()
	if err != nil {
		return rolloutRestartOut{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	patch, _ := json.Marshal(map[string]any{
		"spec": map[string]any{"template": map[string]any{"metadata": map[string]any{
			"annotations": map[string]string{restartAnnotation: now},
		}}},
	})
	if _, _, _, err := send(ctx, c, http.MethodPatch, path, writeQuery(in.Commit, true),
		"application/json", "application/strategic-merge-patch+json", patch, readObjectBytes); err != nil {
		return rolloutRestartOut{}, err
	}
	return rolloutRestartOut{DryRun: !in.Commit, RestartedAt: now}, nil
}
