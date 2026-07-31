{{- define "ivekit.name" -}}
ivekit
{{- end }}

{{- define "ivekit.fullname" -}}
{{- printf "%s-ivekit" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.labels" -}}
{{- include "ivekit.profileValidate" . -}}
app.kubernetes.io/name: {{ include "ivekit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
ivekit.opc.io/profile-core: {{ .Values.deploymentProfiles.core | quote }}
ivekit.opc.io/profile-ai: {{ .Values.deploymentProfiles.ai | quote }}
ivekit.opc.io/profile-observability: {{ .Values.deploymentProfiles.observability | quote }}
ivekit.opc.io/profile-benchmark: {{ .Values.deploymentProfiles.benchmark | quote }}
{{- end }}

{{- define "ivekit.profileValidate" -}}
{{- if not .Values.deploymentProfiles.core -}}
{{- fail "deploymentProfiles.core is mandatory" -}}
{{- end -}}
{{- $aiWorkersEnabled := or
  (eq (toString .Values.config.env.OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED) "1")
  (eq (toString .Values.config.env.OPC_QUALITY_REVIEW_WORKER_ENABLED) "1")
  (eq (toString .Values.config.env.OPC_TRANSLATION_WORKER_ENABLED) "1")
  .Values.workerPools.pools.attachment.enabled
  .Values.workerPools.pools.quality.enabled
  .Values.workerPools.pools.translation.enabled -}}
{{- if and $aiWorkersEnabled (not .Values.deploymentProfiles.ai) -}}
{{- fail "AI workers require deploymentProfiles.ai=true" -}}
{{- end -}}
{{- $observabilityEnabled := or
  .Values.monitoring.serviceMonitor.enabled
  .Values.monitoring.prometheusRule.enabled
  .Values.monitoring.grafanaDashboard.enabled
  .Values.monitoring.sipExporter.enabled
  .Values.telemetry.enabled
  (eq (toString .Values.config.env.OPC_IVEKIT_WORKER_BACKLOG_METRICS_ENABLED) "1")
  .Values.voice.kamailio.sipTrace.enabled -}}
{{- if and $observabilityEnabled (not .Values.deploymentProfiles.observability) -}}
{{- fail "monitoring and SIP tracing require deploymentProfiles.observability=true" -}}
{{- end -}}
{{- if .Values.telemetry.enabled -}}
{{- include "ivekit.telemetryValidate" . -}}
{{- end -}}
{{- end }}

{{- define "ivekit.telemetryValidate" -}}
{{- $endpoint := required "telemetry.collectorEndpoint is required when telemetry is enabled" .Values.telemetry.collectorEndpoint -}}
{{- if not (regexMatch "^https?://[^/@[:space:]]+(:[0-9]+)?(/[^@[:space:]]*)?/v1/traces$" $endpoint) -}}
{{- fail "telemetry.collectorEndpoint must be a credential-free HTTP URL ending in /v1/traces" -}}
{{- end -}}
{{- $ratio := float64 .Values.telemetry.sampleRatio -}}
{{- if or (lt $ratio 0.0) (gt $ratio 1.0) -}}
{{- fail "telemetry.sampleRatio must be between 0 and 1" -}}
{{- end -}}
{{- $queue := int .Values.telemetry.maxQueueSize -}}
{{- $batch := int .Values.telemetry.maxExportBatchSize -}}
{{- if or (lt $queue 128) (gt $queue 65536) -}}
{{- fail "telemetry.maxQueueSize must be between 128 and 65536" -}}
{{- end -}}
{{- if or (lt $batch 1) (gt $batch 8192) (gt $batch $queue) -}}
{{- fail "telemetry.maxExportBatchSize must be between 1 and 8192 and not exceed maxQueueSize" -}}
{{- end -}}
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

{{- define "ivekit.sipExporterFullname" -}}
{{- printf "%s-sip-exporter" (include "ivekit.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.sipExporterImage" -}}
{{- $repository := required "monitoring.sipExporter.image.repository is required when SIP exporter is enabled" .Values.monitoring.sipExporter.image.repository -}}
{{- $digest := required "monitoring.sipExporter.image.digest is required when SIP exporter is enabled" .Values.monitoring.sipExporter.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "monitoring.sipExporter.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "ivekit.clamavFullname" -}}
{{- printf "%s-clamav" (include "ivekit.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "ivekit.clamavHeadlessFullname" -}}
{{- printf "%s-headless" (include "ivekit.clamavFullname" .) | trunc 63 | trimSuffix "-" -}}
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

{{- define "ivekit.tinodeHeadlessFullname" -}}
{{- printf "%s-headless" (include "ivekit.tinodeFullname" .) | trunc 63 | trimSuffix "-" -}}
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
{{- $mode := default "compact" .Values.tinode.mode -}}
{{- if not (or (eq $mode "compact") (eq $mode "cluster")) -}}
{{- fail "tinode.mode must be compact or cluster" -}}
{{- end -}}
{{- if eq $mode "compact" -}}
{{- if ne (int .Values.tinode.replicaCount) 1 -}}
{{- fail "tinode.replicaCount must be 1 in compact mode" -}}
{{- end -}}
{{- if and .Values.tinode.persistence.enabled (not .Values.tinode.persistence.existingClaim) (ne .Values.tinode.persistence.accessMode "ReadWriteOnce") -}}
{{- fail "Tinode compact managed persistence must use ReadWriteOnce" -}}
{{- end -}}
{{- else -}}
{{- if ne (int .Values.tinode.cluster.replicaCount) 3 -}}
{{- fail "tinode.cluster.replicaCount must be exactly 3" -}}
{{- end -}}
{{- if not (has .Values.tinode.image.repository .Values.tinode.image.allowedRepositories) -}}
{{- fail "tinode cluster mode requires the maintained iveKit image repository" -}}
{{- end -}}
{{- if ne .Values.tinode.cluster.media.handler "s3" -}}
{{- fail "tinode cluster mode requires the s3 media handler" -}}
{{- end -}}
{{- $_ := required "tinode.cluster.media.region is required in cluster mode" .Values.tinode.cluster.media.region -}}
{{- $_ := required "tinode.cluster.media.bucket is required in cluster mode" .Values.tinode.cluster.media.bucket -}}
{{- $_ := required "tinode.secrets.accessKeyIdKey is required in cluster mode" .Values.tinode.secrets.accessKeyIdKey -}}
{{- $_ := required "tinode.secrets.secretAccessKeyKey is required in cluster mode" .Values.tinode.secrets.secretAccessKeyKey -}}
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
{{- if .Values.notificationWorker.autoscaling.enabled -}}
{{- $min := int .Values.notificationWorker.autoscaling.minReplicas -}}
{{- $max := int .Values.notificationWorker.autoscaling.maxReplicas -}}
{{- if or (lt $min 1) (gt $max 256) (gt $min $max) -}}
{{- fail "notificationWorker autoscaling requires 1 <= minReplicas <= maxReplicas <= 256" -}}
{{- end -}}
{{- $fallback := int .Values.notificationWorker.autoscaling.fallbackReplicas -}}
{{- if or (lt $fallback $min) (gt $fallback $max) -}}
{{- fail "notificationWorker fallbackReplicas must be within minReplicas and maxReplicas" -}}
{{- end -}}
{{- $_ := required "notificationWorker.autoscaling.prometheusAddress is required" .Values.notificationWorker.autoscaling.prometheusAddress -}}
{{- end -}}
{{- end }}

{{- define "ivekit.workerPoolsValidate" -}}
{{- $allowed := list "eventWebhook" "attachment" "quality" "translation" "fileSecurity" -}}
{{- range $name, $pool := .Values.workerPools.pools -}}
{{- if not (has $name $allowed) -}}
{{- fail (printf "unsupported worker pool %s" $name) -}}
{{- end -}}
{{- $replicas := int $pool.replicaCount -}}
{{- if or (lt $replicas 1) (gt $replicas 256) -}}
{{- fail "worker pool replicaCount must be between 1 and 256" -}}
{{- end -}}
{{- if $pool.autoscaling.enabled -}}
{{- $min := int $pool.autoscaling.minReplicas -}}
{{- $max := int $pool.autoscaling.maxReplicas -}}
{{- if or (lt $min 0) (gt $max 256) (gt $min $max) -}}
{{- fail "worker pool minReplicas must not exceed maxReplicas and both must be between 0 and 256" -}}
{{- end -}}
{{- $fallback := int $pool.autoscaling.fallbackReplicas -}}
{{- if or (lt $fallback 1) (gt $fallback $max) -}}
{{- fail "worker pool fallbackReplicas must be between 1 and maxReplicas" -}}
{{- end -}}
{{- $_ := required "workerPools.autoscaling.prometheusAddress is required" $.Values.workerPools.prometheusAddress -}}
{{- end -}}
{{- end -}}
{{- end }}
