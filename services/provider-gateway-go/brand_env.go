package main

import (
	"encoding/json"
	"fmt"
	"regexp"
)

type brandEnvDeprecationEvent struct {
	Event      string `json:"event"`
	Scope      string `json:"scope"`
	CurrentKey string `json:"current_key"`
	LegacyKey  string `json:"legacy_key"`
}

func (event brandEnvDeprecationEvent) String() string {
	encoded, _ := json.Marshal(event)
	return string(encoded)
}

var envSuffix = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

func resolveBrandEnv(
	lookup func(string) (string, bool),
	suffix string,
	onDeprecation func(brandEnvDeprecationEvent),
) (string, bool, error) {
	return resolveBrandedEnv(lookup, "brand", "CONVERACT_", "OPC_", suffix, onDeprecation)
}

func resolveFabricEnv(
	lookup func(string) (string, bool),
	suffix string,
	onDeprecation func(brandEnvDeprecationEvent),
) (string, bool, error) {
	return resolveBrandedEnv(
		lookup,
		"fabric",
		"CONVERACT_FABRIC_",
		"OPC_IVEKIT_",
		suffix,
		onDeprecation,
	)
}

func resolveBrandedEnv(
	lookup func(string) (string, bool),
	scope string,
	currentPrefix string,
	legacyPrefix string,
	suffix string,
	onDeprecation func(brandEnvDeprecationEvent),
) (string, bool, error) {
	if !envSuffix.MatchString(suffix) {
		return "", false, fmt.Errorf("invalid branded environment variable suffix: %s", suffix)
	}
	currentKey := currentPrefix + suffix
	legacyKey := legacyPrefix + suffix
	current, hasCurrent := lookup(currentKey)
	legacy, hasLegacy := lookup(legacyKey)
	if hasCurrent && hasLegacy && current != legacy {
		return "", false, fmt.Errorf(
			"conflicting branded environment variables: %s and %s",
			currentKey,
			legacyKey,
		)
	}
	if hasCurrent {
		return current, true, nil
	}
	if !hasLegacy {
		return "", false, nil
	}
	if onDeprecation != nil {
		onDeprecation(brandEnvDeprecationEvent{
			Event:      "converact.config.deprecated_environment_key",
			Scope:      scope,
			CurrentKey: currentKey,
			LegacyKey:  legacyKey,
		})
	}
	return legacy, true, nil
}
