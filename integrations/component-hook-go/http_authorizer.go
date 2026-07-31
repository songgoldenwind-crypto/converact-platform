package componenthook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maximumResponseBytes = 131_072

type HTTPAuthorizerConfig struct {
	Endpoint     string
	ServiceToken string
	Timeout      time.Duration
	Client       *http.Client
}

type HTTPAuthorizer struct {
	endpoint *url.URL
	token    string
	client   *http.Client
}

type BatchAuthorizationResult struct {
	Request       AuthorizationRequest
	Authorization Authorization
	Error         *HTTPAuthorizationError
}

func NewHTTPAuthorizer(config HTTPAuthorizerConfig) (*HTTPAuthorizer, error) {
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.User != nil ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return nil, fmt.Errorf("componenthook: invalid node endpoint")
	}
	if len(config.ServiceToken) < 24 || len(config.ServiceToken) > 512 ||
		strings.ContainsAny(config.ServiceToken, "\x00\r\n") {
		return nil, fmt.Errorf("componenthook: invalid service token")
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = 2 * time.Second
	}
	if timeout < 100*time.Millisecond || timeout > 30*time.Second {
		return nil, fmt.Errorf("componenthook: invalid HTTP timeout")
	}
	client := config.Client
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	return &HTTPAuthorizer{
		endpoint: endpoint,
		token:    config.ServiceToken,
		client:   client,
	}, nil
}

func (authorizer *HTTPAuthorizer) Authorize(
	ctx context.Context,
	input AuthorizationRequest,
) (Authorization, error) {
	body, err := json.Marshal(input)
	if err != nil {
		return Authorization{}, err
	}
	endpoint := authorizer.endpoint.ResolveReference(&url.URL{
		Path: "/v1/authorize",
	})
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint.String(),
		bytes.NewReader(body),
	)
	if err != nil {
		return Authorization{}, err
	}
	request.Header.Set("Authorization", "Bearer "+authorizer.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := authorizer.client.Do(request)
	if err != nil {
		return Authorization{}, err
	}
	defer response.Body.Close()
	if response.ContentLength > maximumResponseBytes {
		return Authorization{}, fmt.Errorf("componenthook: response too large")
	}
	raw, err := io.ReadAll(io.LimitReader(
		response.Body,
		maximumResponseBytes+1,
	))
	if err != nil {
		return Authorization{}, err
	}
	if len(raw) > maximumResponseBytes {
		return Authorization{}, fmt.Errorf("componenthook: response too large")
	}
	var envelope struct {
		Data struct {
			Allowed        bool   `json:"allowed"`
			Component      string `json:"component"`
			NodeID         string `json:"node_id"`
			CellLeaseEpoch uint64 `json:"cell_lease_epoch"`
			OwnerEpoch     string `json:"owner_epoch"`
			StateSequence  uint64 `json:"state_sequence"`
			LeaseExpiresAt string `json:"lease_expires_at"`
		} `json:"data"`
		Error struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return Authorization{}, fmt.Errorf("componenthook: invalid response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Authorization{}, &HTTPAuthorizationError{
			Code:       safeErrorCode(envelope.Error.Code),
			StatusCode: response.StatusCode,
			Retryable:  envelope.Error.Retryable,
		}
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, envelope.Data.LeaseExpiresAt)
	if err != nil {
		return Authorization{}, fmt.Errorf("componenthook: invalid lease expiry")
	}
	return Authorization{
		Allowed:        envelope.Data.Allowed,
		Component:      envelope.Data.Component,
		NodeID:         envelope.Data.NodeID,
		CellLeaseEpoch: envelope.Data.CellLeaseEpoch,
		OwnerEpoch:     envelope.Data.OwnerEpoch,
		StateSequence:  envelope.Data.StateSequence,
		LeaseExpiresAt: expiresAt,
	}, nil
}

func (authorizer *HTTPAuthorizer) AuthorizeBatch(
	ctx context.Context,
	inputs []AuthorizationRequest,
) ([]BatchAuthorizationResult, error) {
	if len(inputs) == 0 || len(inputs) > 64 {
		return nil, fmt.Errorf("componenthook: invalid authorization batch")
	}
	body, err := json.Marshal(struct {
		Requests []AuthorizationRequest `json:"requests"`
	}{Requests: inputs})
	if err != nil {
		return nil, err
	}
	raw, err := authorizer.request(ctx, "/v1/authorize/batch", body)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Data struct {
			Results []struct {
				Request       AuthorizationRequest `json:"request"`
				Authorization struct {
					Allowed        bool   `json:"allowed"`
					Component      string `json:"component"`
					NodeID         string `json:"node_id"`
					CellLeaseEpoch uint64 `json:"cell_lease_epoch"`
					OwnerEpoch     string `json:"owner_epoch"`
					StateSequence  uint64 `json:"state_sequence"`
					LeaseExpiresAt string `json:"lease_expires_at"`
				} `json:"authorization"`
				Error struct {
					Code      string `json:"code"`
					Status    int    `json:"status"`
					Retryable bool   `json:"retryable"`
				} `json:"error"`
			} `json:"results"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("componenthook: invalid batch response: %w", err)
	}
	if len(envelope.Data.Results) != len(inputs) {
		return nil, fmt.Errorf("componenthook: incomplete batch response")
	}
	results := make([]BatchAuthorizationResult, 0, len(inputs))
	for index, item := range envelope.Data.Results {
		if item.Request != inputs[index] {
			return nil, fmt.Errorf("componenthook: reordered batch response")
		}
		result := BatchAuthorizationResult{Request: item.Request}
		if item.Error.Code != "" {
			result.Error = &HTTPAuthorizationError{
				Code:       safeErrorCode(item.Error.Code),
				StatusCode: item.Error.Status,
				Retryable:  item.Error.Retryable,
			}
		} else {
			expiresAt, err := time.Parse(
				time.RFC3339Nano,
				item.Authorization.LeaseExpiresAt,
			)
			if err != nil {
				return nil, fmt.Errorf("componenthook: invalid lease expiry")
			}
			result.Authorization = Authorization{
				Allowed:        item.Authorization.Allowed,
				Component:      item.Authorization.Component,
				NodeID:         item.Authorization.NodeID,
				CellLeaseEpoch: item.Authorization.CellLeaseEpoch,
				OwnerEpoch:     item.Authorization.OwnerEpoch,
				StateSequence:  item.Authorization.StateSequence,
				LeaseExpiresAt: expiresAt,
			}
		}
		results = append(results, result)
	}
	return results, nil
}

func (authorizer *HTTPAuthorizer) request(
	ctx context.Context,
	path string,
	body []byte,
) ([]byte, error) {
	endpoint := authorizer.endpoint.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint.String(),
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+authorizer.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := authorizer.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.ContentLength > maximumResponseBytes {
		return nil, fmt.Errorf("componenthook: response too large")
	}
	raw, err := io.ReadAll(io.LimitReader(
		response.Body,
		maximumResponseBytes+1,
	))
	if err != nil {
		return nil, err
	}
	if len(raw) > maximumResponseBytes {
		return nil, fmt.Errorf("componenthook: response too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var envelope struct {
			Error struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &envelope)
		return nil, &HTTPAuthorizationError{
			Code:       safeErrorCode(envelope.Error.Code),
			StatusCode: response.StatusCode,
			Retryable:  envelope.Error.Retryable,
		}
	}
	return raw, nil
}

type HTTPAuthorizationError struct {
	Code       string
	StatusCode int
	Retryable  bool
}

func (failure *HTTPAuthorizationError) Error() string {
	return fmt.Sprintf(
		"componenthook: authorization failed: %s (%d)",
		failure.Code,
		failure.StatusCode,
	)
}

func safeErrorCode(value string) string {
	if len(value) < 2 || len(value) > 128 {
		return "component_node_unavailable"
	}
	for index, character := range value {
		if (index == 0 && character >= 'a' && character <= 'z') ||
			(index > 0 && ((character >= 'a' && character <= 'z') ||
				(character >= '0' && character <= '9') || character == '_')) {
			continue
		}
		return "component_node_unavailable"
	}
	return value
}
