{{- define "kube-console.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kube-console.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "kube-console.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "kube-console.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ include "kube-console.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kube-console.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kube-console.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kube-console.validateCa" -}}
{{- if and .Values.ca.existingCaConfigMap .Values.ca.existingCaSecret -}}
{{- fail "Set only one of ca.existingCaConfigMap and ca.existingCaSecret" -}}
{{- end -}}
{{- end -}}

{{/*
Effective CA ConfigMap name: an explicit override, else the auto-published
`kube-root-ca.crt` when useClusterRootCA is on and no Secret is set. Empty
otherwise. A Secret source always takes precedence over the default ConfigMap.
*/}}
{{- define "kube-console.caConfigMap" -}}
{{- if .Values.ca.existingCaConfigMap -}}
{{- .Values.ca.existingCaConfigMap -}}
{{- else if and .Values.ca.useClusterRootCA (not .Values.ca.existingCaSecret) -}}
{{- "kube-root-ca.crt" -}}
{{- end -}}
{{- end -}}
