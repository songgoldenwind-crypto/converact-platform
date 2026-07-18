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
