{{- define "opc.opcImage" -}}
{{- $repository := required "opc.image.repository is required" .Values.opc.image.repository -}}
{{- $digest := required "opc.image.digest is required" .Values.opc.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "opc.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.aiAgentImage" -}}
{{- $repository := required "aiAgent.image.repository is required" .Values.aiAgent.image.repository -}}
{{- $digest := required "aiAgent.image.digest is required" .Values.aiAgent.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "aiAgent.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.frontendImage" -}}
{{- $repository := required "frontend.image.repository is required" .Values.frontend.image.repository -}}
{{- $digest := required "frontend.image.digest is required" .Values.frontend.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "frontend.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.postgresImage" -}}
{{- $repository := required "postgres.image.repository is required" .Values.postgres.image.repository -}}
{{- $digest := required "postgres.image.digest is required" .Values.postgres.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "postgres.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.postgresMode" -}}
{{- $mode := .Values.postgres.mode | default "external" -}}
{{- if not (has $mode (list "external" "bundled-dev")) -}}
{{- fail "postgres.mode must be external or bundled-dev" -}}
{{- end -}}
{{- $mode -}}
{{- end }}

{{- define "opc.databaseUrlSecretName" -}}
{{- if eq (include "opc.postgresMode" .) "external" -}}
{{- required "postgres.external.existingSecret is required in external mode" .Values.postgres.external.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" .Release.Name -}}
{{- end -}}
{{- end }}

{{- define "opc.databaseUrlSecretKey" -}}
{{- if eq (include "opc.postgresMode" .) "external" -}}
{{- required "postgres.external.secretKey is required in external mode" .Values.postgres.external.secretKey -}}
{{- else -}}
database-url
{{- end -}}
{{- end }}

{{- define "opc.objectStorageMode" -}}
{{- $storage := .Values.media.objectStorage -}}
{{- $mode := $storage.mode | default "external" -}}
{{- if not (has $mode (list "external" "legacy-minio")) -}}
{{- fail "media.objectStorage.mode must be external or legacy-minio" -}}
{{- end -}}
{{- if and .Values.media.minio.enabled (ne $mode "legacy-minio") -}}
{{- fail "bundled MinIO requires media.objectStorage.mode=legacy-minio" -}}
{{- end -}}
{{- if eq $mode "external" -}}
{{- $requiredBucket := required "media.objectStorage.bucket is required in external mode" $storage.bucket -}}
{{- $requiredRegion := required "media.objectStorage.region is required in external mode" $storage.region -}}
{{- $authMode := $storage.authMode | default "secret" -}}
{{- if not (has $authMode (list "secret" "workload-identity")) -}}
{{- fail "media.objectStorage.authMode must be secret or workload-identity" -}}
{{- end -}}
{{- if eq $authMode "secret" -}}
{{- $requiredSecret := required "media.objectStorage.existingSecret is required with secret authentication" $storage.existingSecret -}}
{{- $requiredAccessKey := required "media.objectStorage.accessKeyIdKey is required with secret authentication" $storage.accessKeyIdKey -}}
{{- $requiredSecretKey := required "media.objectStorage.secretAccessKeyKey is required with secret authentication" $storage.secretAccessKeyKey -}}
{{- end -}}
{{- else -}}
{{- $requiredLegacySecret := required "media.minio.existingSecret is required in legacy-minio mode" .Values.media.minio.existingSecret -}}
{{- $requiredLegacyAccessKey := required "media.minio.accessKeyIdKey is required in legacy-minio mode" .Values.media.minio.accessKeyIdKey -}}
{{- $requiredLegacySecretKey := required "media.minio.secretAccessKeyKey is required in legacy-minio mode" .Values.media.minio.secretAccessKeyKey -}}
{{- end -}}
{{- $mode -}}
{{- end }}

{{- define "opc.objectStorageEndpoint" -}}
{{- if eq (include "opc.objectStorageMode" .) "external" -}}
{{- .Values.media.objectStorage.endpoint | default "" -}}
{{- else -}}
{{- .Values.media.minio.endpoint | default (printf "http://%s-minio:9000" .Release.Name) -}}
{{- end -}}
{{- end }}

{{- define "opc.objectStorageBucket" -}}
{{- if eq (include "opc.objectStorageMode" .) "external" -}}
{{- .Values.media.objectStorage.bucket -}}
{{- else -}}
{{- .Values.media.minio.bucket | default "recordings" -}}
{{- end -}}
{{- end }}

{{- define "opc.objectStorageRegion" -}}
{{- if eq (include "opc.objectStorageMode" .) "external" -}}
{{- .Values.media.objectStorage.region -}}
{{- else -}}
us-east-1
{{- end -}}
{{- end }}

{{- define "opc.objectStorageForcePathStyle" -}}
{{- if eq (include "opc.objectStorageMode" .) "external" -}}
{{- .Values.media.objectStorage.forcePathStyle -}}
{{- else -}}
true
{{- end -}}
{{- end }}

{{- define "opc.objectStorageSecretName" -}}
{{- if eq (include "opc.objectStorageMode" .) "external" -}}
{{- required "media.objectStorage.existingSecret is required with secret authentication" .Values.media.objectStorage.existingSecret -}}
{{- else -}}
{{- required "media.minio.existingSecret is required in legacy-minio mode" .Values.media.minio.existingSecret -}}
{{- end -}}
{{- end }}

{{- define "opc.objectStorageAccessKeyIdKey" -}}
{{- if eq (include "opc.objectStorageMode" .) "external" -}}
{{- .Values.media.objectStorage.accessKeyIdKey -}}
{{- else -}}
{{- .Values.media.minio.accessKeyIdKey -}}
{{- end -}}
{{- end }}

{{- define "opc.objectStorageSecretAccessKeyKey" -}}
{{- if eq (include "opc.objectStorageMode" .) "external" -}}
{{- .Values.media.objectStorage.secretAccessKeyKey -}}
{{- else -}}
{{- .Values.media.minio.secretAccessKeyKey -}}
{{- end -}}
{{- end }}

{{- define "opc.objectStorageEnv" -}}
{{- $mode := include "opc.objectStorageMode" . -}}
- name: S3_ENDPOINT
  value: {{ include "opc.objectStorageEndpoint" . | quote }}
- name: S3_BUCKET
  value: {{ include "opc.objectStorageBucket" . | quote }}
- name: S3_REGION
  value: {{ include "opc.objectStorageRegion" . | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ include "opc.objectStorageForcePathStyle" . | quote }}
{{- if or (eq $mode "legacy-minio") (eq (.Values.media.objectStorage.authMode | default "secret") "secret") }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "opc.objectStorageSecretName" . }}
      key: {{ include "opc.objectStorageAccessKeyIdKey" . }}
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "opc.objectStorageSecretName" . }}
      key: {{ include "opc.objectStorageSecretAccessKeyKey" . }}
{{- end }}
{{- end }}

{{- define "opc.redisImage" -}}
{{- $repository := required "redis.image.repository is required" .Values.redis.image.repository -}}
{{- $digest := required "redis.image.digest is required" .Values.redis.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "redis.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.natsImage" -}}
{{- $repository := required "nats.image.repository is required" .Values.nats.image.repository -}}
{{- $digest := required "nats.image.digest is required" .Values.nats.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "nats.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.livekitImage" -}}
{{- $repository := required "livekit.image.repository is required when bundled LiveKit is enabled" .Values.livekit.image.repository -}}
{{- $digest := required "livekit.image.digest is required when bundled LiveKit is enabled" .Values.livekit.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "livekit.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.livekitSipImage" -}}
{{- $repository := required "media.sip.image.repository is required when LiveKit SIP is enabled" .Values.media.sip.image.repository -}}
{{- $digest := required "media.sip.image.digest is required when LiveKit SIP is enabled" .Values.media.sip.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "media.sip.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.rustdeskImage" -}}
{{- $repository := required "rustdesk.image.repository is required when RustDesk is enabled" .Values.rustdesk.image.repository -}}
{{- $digest := required "rustdesk.image.digest is required when RustDesk is enabled" .Values.rustdesk.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "rustdesk.image.digest must be an immutable sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end }}

{{- define "opc.livekitInternalUrl" -}}
{{- if .Values.livekit.url -}}
{{- .Values.livekit.url -}}
{{- else if .Values.livekit.enabled -}}
{{- printf "ws://%s-livekit:7880" .Release.Name -}}
{{- else -}}
{{- required "livekit.url is required when livekit.enabled=false" .Values.livekit.url -}}
{{- end -}}
{{- end }}

{{- define "opc.livekitRedisAddress" -}}
{{- if .Values.livekit.redis.address -}}
{{- .Values.livekit.redis.address -}}
{{- else if and .Values.livekit.enabled .Values.redis.enabled -}}
{{- printf "%s-redis:6379" .Release.Name -}}
{{- else -}}
{{- required "livekit.redis.address is required when external LiveKit uses in-chart Egress or bundled Redis is disabled" .Values.livekit.redis.address -}}
{{- end -}}
{{- end }}

{{- define "opc.livekitRedisConfig" -}}
{{- $redis := .Values.livekit.redis -}}
{{- $mode := $redis.mode | default "direct" -}}
{{- if not (has $mode (list "direct" "sentinel")) -}}
{{- fail "livekit.redis.mode must be direct or sentinel" -}}
{{- end -}}
{{- if ne (empty $redis.username) (empty $redis.password) -}}
{{- fail "livekit.redis username and password must be configured together" -}}
{{- end -}}
{{- if ne (empty $redis.sentinelUsername) (empty $redis.sentinelPassword) -}}
{{- fail "livekit.redis Sentinel username and password must be configured together" -}}
{{- end -}}
{{- if eq $mode "direct" -}}
{{- if or $redis.sentinelMasterName (gt (len $redis.sentinelAddresses) 0) $redis.sentinelUsername $redis.sentinelPassword -}}
{{- fail "livekit.redis.sentinel fields must be empty in direct mode" -}}
{{- end }}
address: {{ include "opc.livekitRedisAddress" . | quote }}
{{- else -}}
{{- if $redis.address -}}
{{- fail "livekit.redis.address must be empty in sentinel mode" -}}
{{- end -}}
{{- if not $redis.sentinelMasterName -}}
{{- fail "livekit.redis.sentinelMasterName is required in sentinel mode" -}}
{{- end -}}
{{- if ne (len $redis.sentinelAddresses) 3 -}}
{{- fail "livekit.redis.sentinelAddresses must contain exactly three addresses" -}}
{{- end -}}
{{- if ne (len (uniq $redis.sentinelAddresses)) 3 -}}
{{- fail "livekit.redis.sentinelAddresses must contain three unique addresses" -}}
{{- end }}
sentinel_master_name: {{ $redis.sentinelMasterName | quote }}
sentinel_addresses:
{{- range $address := $redis.sentinelAddresses }}
  - {{ $address | quote }}
{{- end }}
sentinel_username: {{ $redis.sentinelUsername | quote }}
sentinel_password: {{ $redis.sentinelPassword | quote }}
{{- end }}
username: {{ $redis.username | quote }}
password: {{ $redis.password | quote }}
db: {{ $redis.db }}
dial_timeout: {{ $redis.dialTimeoutMs | default 2000 }}
read_timeout: {{ $redis.readTimeoutMs | default 200 }}
write_timeout: {{ $redis.writeTimeoutMs | default 200 }}
pool_size: {{ $redis.poolSize | default 0 }}
{{- $tls := $redis.tls -}}
{{- if $tls.enabled -}}
{{- if not $tls.secretName -}}
{{- fail "livekit.redis.tls.secretName is required when TLS is enabled" -}}
{{- end -}}
{{- if not $tls.serverName -}}
{{- fail "livekit.redis.tls.serverName is required when TLS is enabled" -}}
{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9._-]+$" $tls.caKey) -}}
{{- fail "livekit.redis.tls.caKey must be a safe Kubernetes Secret key" -}}
{{- end -}}
{{- if ne (empty $tls.clientCertKey) (empty $tls.clientKeyKey) -}}
{{- fail "livekit.redis.tls client certificate and key must be configured together" -}}
{{- end -}}
{{- if and $tls.clientCertKey (not (regexMatch "^[A-Za-z0-9._-]+$" $tls.clientCertKey)) -}}
{{- fail "livekit.redis.tls.clientCertKey must be a safe Kubernetes Secret key" -}}
{{- end -}}
{{- if and $tls.clientKeyKey (not (regexMatch "^[A-Za-z0-9._-]+$" $tls.clientKeyKey)) -}}
{{- fail "livekit.redis.tls.clientKeyKey must be a safe Kubernetes Secret key" -}}
{{- end }}
tls:
  enabled: true
  insecure: false
  server_name: {{ $tls.serverName | quote }}
  ca_cert_file: /etc/livekit-redis-tls/ca.crt
{{- if $tls.clientCertKey }}
  client_cert_file: /etc/livekit-redis-tls/client.crt
  client_key_file: /etc/livekit-redis-tls/client.key
{{- end -}}
{{- end -}}
{{- end }}

{{- define "opc.redisClientEnv" -}}
{{- $redis := .Values.livekit.redis -}}
{{- $mode := $redis.mode | default "direct" -}}
- name: REDIS_TOPOLOGY
  value: {{ $mode | quote }}
{{- if eq $mode "direct" }}
- name: REDIS_URL
  value: {{ printf "%s://%s" (ternary "rediss" "redis" $redis.tls.enabled) (include "opc.livekitRedisAddress" .) | quote }}
{{- else }}
- name: REDIS_SENTINEL_MASTER_NAME
  value: {{ $redis.sentinelMasterName | quote }}
- name: REDIS_SENTINEL_ADDRESSES
  value: {{ join "," $redis.sentinelAddresses | quote }}
{{- end }}
- name: REDIS_USERNAME
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-secrets
      key: redis-username
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-secrets
      key: redis-password
- name: REDIS_SENTINEL_USERNAME
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-secrets
      key: redis-sentinel-username
- name: REDIS_SENTINEL_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-secrets
      key: redis-sentinel-password
- name: REDIS_TLS_MODE
  value: {{ ternary "required" "disabled" $redis.tls.enabled | quote }}
{{- if $redis.tls.enabled }}
- name: REDIS_TLS_SERVER_NAME
  value: {{ $redis.tls.serverName | quote }}
- name: REDIS_TLS_CA_FILE
  value: /etc/livekit-redis-tls/ca.crt
{{- if $redis.tls.clientCertKey }}
- name: REDIS_TLS_CERT_FILE
  value: /etc/livekit-redis-tls/client.crt
- name: REDIS_TLS_KEY_FILE
  value: /etc/livekit-redis-tls/client.key
{{- end }}
{{- end }}
- name: REDIS_CONNECT_TIMEOUT_MS
  value: {{ $redis.dialTimeoutMs | default 2000 | quote }}
- name: REDIS_RECONNECT_WAIT_MS
  value: {{ $redis.reconnectWaitMs | default 1000 | quote }}
- name: REDIS_MAX_RECONNECT_ATTEMPTS
  value: {{ $redis.maxReconnectAttempts | default -1 | quote }}
{{- end -}}

{{- define "opc.livekitRedisTLSVolumeMount" -}}
{{- if .Values.livekit.redis.tls.enabled }}
- name: livekit-redis-tls
  mountPath: /etc/livekit-redis-tls
  readOnly: true
{{- end -}}
{{- end }}

{{- define "opc.livekitRedisTLSVolume" -}}
{{- $tls := .Values.livekit.redis.tls -}}
{{- if $tls.enabled }}
- name: livekit-redis-tls
  secret:
    secretName: {{ $tls.secretName | quote }}
    items:
      - key: {{ $tls.caKey | quote }}
        path: ca.crt
{{- if $tls.clientCertKey }}
      - key: {{ $tls.clientCertKey | quote }}
        path: client.crt
      - key: {{ $tls.clientKeyKey | quote }}
        path: client.key
{{- end -}}
{{- end -}}
{{- end }}

{{- define "opc.livekitPublicUrl" -}}
{{- $url := required "livekit.publicUrl is required for browser joins" .Values.livekit.publicUrl -}}
{{- $mode := .Values.livekit.deploymentMode | default "external" -}}
{{- if and (ne $mode "bundled-dev") (not (regexMatch "^wss://" $url)) -}}
{{- fail "livekit.publicUrl must use wss:// outside bundled-dev" -}}
{{- end -}}
{{- $url -}}
{{- end }}

{{- define "opc.livekitApiKey" -}}
{{- $key := required "livekit.apiKey is required" .Values.livekit.apiKey -}}
{{- if and (ne (.Values.livekit.deploymentMode | default "external") "bundled-dev") (eq $key "devkey") -}}
{{- fail "livekit.apiKey must not use the bundled development value" -}}
{{- end -}}
{{- $key -}}
{{- end }}

{{- define "opc.livekitApiSecret" -}}
{{- $secret := required "livekit.apiSecret is required" .Values.livekit.apiSecret -}}
{{- if and (ne (.Values.livekit.deploymentMode | default "external") "bundled-dev") (eq $secret "secret") -}}
{{- fail "livekit.apiSecret must not use the bundled development value" -}}
{{- end -}}
{{- $secret -}}
{{- end }}
