{{- define "ivekit.name" -}}
ivekit
{{- end }}

{{- define "ivekit.fullname" -}}
{{- printf "%s-ivekit" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.labels" -}}
app.kubernetes.io/name: {{ include "ivekit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end }}

{{- define "ivekit.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ivekit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ivekit.secretName" -}}
{{- required "secrets.existingSecret is required" .Values.secrets.existingSecret -}}
{{- end }}

{{- define "ivekit.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $digest := required "image.digest is required" .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "ivekit.rustpbxImage" -}}
{{- $repository := required "voice.image.repository is required when voice is enabled" .Values.voice.image.repository -}}
{{- $digest := required "voice.image.digest is required when voice is enabled" .Values.voice.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "voice.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}
