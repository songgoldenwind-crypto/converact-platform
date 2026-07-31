package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type proxyRequest struct {
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	TimeoutMS int               `json:"timeout_ms"`
}

type gatewayEnvelope struct {
	IntegrationID string       `json:"integration_id"`
	Operation     string       `json:"operation"`
	Request       proxyRequest `json:"request"`
}

type gatewayResponse struct {
	Status     string      `json:"status"`
	StatusCode int         `json:"status_code"`
	Headers    http.Header `json:"headers,omitempty"`
	Body       any         `json:"body,omitempty"`
	Error      string      `json:"error,omitempty"`
}

func main() {
	port := envOrDefault("PORT", "8091")
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "ok",
			"service": "provider-gateway-go",
		})
	})
	mux.HandleFunc("/health-check", func(w http.ResponseWriter, r *http.Request) {
		proxyHandler(w, r, "health_check")
	})
	mux.HandleFunc("/execute", func(w http.ResponseWriter, r *http.Request) {
		proxyHandler(w, r, "execute")
	})

	log.Printf("provider-gateway-go listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

func proxyHandler(w http.ResponseWriter, r *http.Request, mode string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}

	var envelope gatewayEnvelope
	if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": err.Error()})
		return
	}
	if envelope.Request.URL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "request.url is required"})
		return
	}

	timeoutMS := envelope.Request.TimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 1500
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()

	reqBody := io.Reader(nil)
	if envelope.Request.Body != "" {
		reqBody = bytes.NewBufferString(envelope.Request.Body)
	}
	method := envelope.Request.Method
	if method == "" {
		method = http.MethodPost
	}

	req, err := http.NewRequestWithContext(ctx, method, envelope.Request.URL, reqBody)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "message": err.Error()})
		return
	}
	for key, value := range envelope.Request.Headers {
		if value != "" {
			req.Header.Set(key, value)
		}
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":       "upstream_request_failed",
			"integration": envelope.IntegrationID,
			"operation":   envelope.Operation,
			"message":     err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "failed_to_read_upstream", "message": err.Error()})
		return
	}

	parsedBody := parseBody(resp.Header.Get("content-type"), bodyBytes)
	writeJSON(w, http.StatusOK, gatewayResponse{
		Status:     mode,
		StatusCode: resp.StatusCode,
		Headers:    resp.Header,
		Body:       parsedBody,
		Error:      "",
	})
}

func parseBody(contentType string, raw []byte) any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	if contentType == "" {
		contentType = http.DetectContentType(raw)
	}
	if containsJSON(contentType) {
		var value any
		if err := json.Unmarshal(raw, &value); err == nil {
			return value
		}
	}
	return map[string]any{
		"raw": string(raw),
	}
}

func containsJSON(contentType string) bool {
	return strings.Contains(strings.ToLower(contentType), "json")
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-service", "provider-gateway-go")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(payload); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"encode_failed","message":%q}`, err.Error()), http.StatusInternalServerError)
	}
}

func init() {
	if timeoutRaw := os.Getenv("OPC_PROVIDER_GATEWAY_TIMEOUT_MS"); timeoutRaw != "" {
		if _, err := strconv.Atoi(timeoutRaw); err != nil {
			log.Printf("warning: OPC_PROVIDER_GATEWAY_TIMEOUT_MS is invalid: %v", err)
		}
	}
}
