{{- define "converact-homer.name" -}}
converact-homer
{{- end }}

{{- define "converact-homer.fullname" -}}
{{- printf "%s-homer" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "converact-homer.labels" -}}
app.kubernetes.io/name: {{ include "converact-homer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: homer
{{- end }}

{{- define "converact-homer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "converact-homer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: homer
{{- end }}

{{- define "converact-homer.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $digest := required "image.digest is required" .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "converact-homer.validate" -}}
{{- if ne .Values.homer.catalogType "postgres" -}}
{{- fail "homer.catalogType must be postgres; Converact Fabric does not deploy SQLite" -}}
{{- end -}}
{{- if ne (int .Values.replicaCount) 1 -}}
{{- fail "replicaCount must be 1; deploy one independent release per Cell" -}}
{{- end -}}
{{- if ne (int .Values.homer.storage.shardCount) 1 -}}
{{- fail "homer.storage.shardCount must be 1 for a PostgreSQL DuckLake catalog" -}}
{{- end -}}
{{- $_ := required "secrets.existingSecret is required" .Values.secrets.existingSecret -}}
{{- if .Values.networkPolicy.enabled -}}
  {{- if empty .Values.networkPolicy.kamailioNamespaceSelector -}}
    {{- fail "networkPolicy.kamailioNamespaceSelector is required when NetworkPolicy is enabled" -}}
  {{- end -}}
  {{- if empty .Values.networkPolicy.postgresEgressCidrs -}}
    {{- fail "networkPolicy.postgresEgressCidrs is required when NetworkPolicy is enabled" -}}
  {{- end -}}
  {{- range .Values.networkPolicy.postgresEgressCidrs -}}
    {{- if or (eq . "0.0.0.0/0") (eq . "::/0") -}}
      {{- fail "networkPolicy.postgresEgressCidrs must not contain a default route" -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end }}
