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
{{- if regexMatch "(^|/)restsend/rustpbx$" $repository -}}
{{- fail "voice.image.repository must reference the iveKit-patched RustPBX image, not the unpatched upstream image" -}}
{{- end -}}
{{- $digest := required "voice.image.digest is required when voice is enabled" .Values.voice.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "voice.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "ivekit.kamailioImage" -}}
{{- $repository := required "voice.kamailio.image.repository is required when Kamailio is enabled" .Values.voice.kamailio.image.repository -}}
{{- $digest := required "voice.kamailio.image.digest is required when Kamailio is enabled" .Values.voice.kamailio.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "voice.kamailio.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "ivekit.rustpbxHeadlessFullname" -}}
{{- printf "%s-rustpbx-headless" (include "ivekit.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.kamailioFullname" -}}
{{- printf "%s-kamailio" (include "ivekit.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.clamavFullname" -}}
{{- printf "%s-clamav" (include "ivekit.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.clamavImage" -}}
{{- $repository := required "clamav.image.repository is required when ClamAV is enabled" .Values.clamav.image.repository -}}
{{- $digest := required "clamav.image.digest is required when ClamAV is enabled" .Values.clamav.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "clamav.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "ivekit.tinodeFullname" -}}
{{- printf "%s-tinode" (include "ivekit.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.tinodeImage" -}}
{{- $repository := required "tinode.image.repository is required when bundled Tinode is enabled" .Values.tinode.image.repository -}}
{{- $digest := required "tinode.image.digest is required when bundled Tinode is enabled" .Values.tinode.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "tinode.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "ivekit.tinodeValidate" -}}
{{- if ne (int .Values.tinode.replicaCount) 1 -}}
{{- fail "bundled Tinode supports exactly one replica; use an external Tinode cluster for high availability" -}}
{{- end -}}
{{- if and .Values.tinode.persistence.enabled (not .Values.tinode.persistence.existingClaim) (ne .Values.tinode.persistence.accessMode "ReadWriteOnce") -}}
{{- fail "bundled Tinode managed persistence must use ReadWriteOnce" -}}
{{- end -}}
{{- if not (regexMatch "^wss://[^[:space:]]+/v0/channels([?].*)?$" (required "tinode.publicWsUrl is required when bundled Tinode is enabled" .Values.tinode.publicWsUrl)) -}}
{{- fail "tinode.publicWsUrl must be a production WSS /v0/channels URL" -}}
{{- end -}}
{{- if not (regexMatch "^[01]$" .Values.tinode.config.deliveryWorkerEnabled) -}}
{{- fail "tinode.config.deliveryWorkerEnabled must be 0 or 1" -}}
{{- end -}}
{{- if not (regexMatch "^[01]$" .Values.tinode.config.inboundWorkerEnabled) -}}
{{- fail "tinode.config.inboundWorkerEnabled must be 0 or 1" -}}
{{- end -}}
{{- end }}

{{- define "ivekit.notificationWorkerFullname" -}}
{{- printf "%s-notification-worker" (include "ivekit.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.notificationWorkerValidate" -}}
{{- $replicas := int .Values.notificationWorker.replicaCount -}}
{{- if or (lt $replicas 1) (gt $replicas 256) -}}
{{- fail "notificationWorker.replicaCount must be between 1 and 256" -}}
{{- end -}}
{{- end }}
