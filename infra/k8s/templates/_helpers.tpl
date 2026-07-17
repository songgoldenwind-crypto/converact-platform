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
