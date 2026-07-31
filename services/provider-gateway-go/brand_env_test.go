package main

import (
	"strings"
	"testing"
)

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestResolveBrandEnvContract(t *testing.T) {
	tests := []struct {
		name   string
		values map[string]string
		want   string
	}{
		{name: "current", values: map[string]string{"CONVERACT_API_KEY": "new"}, want: "new"},
		{name: "legacy", values: map[string]string{"OPC_API_KEY": "old"}, want: "old"},
		{name: "equal", values: map[string]string{"CONVERACT_API_KEY": "same", "OPC_API_KEY": "same"}, want: "same"},
		{name: "empty", values: map[string]string{"CONVERACT_API_KEY": ""}, want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, present, err := resolveBrandEnv(lookup(test.values), "API_KEY", nil)
			if err != nil {
				t.Fatal(err)
			}
			if !present || got != test.want {
				t.Fatalf("got (%q, %v), want (%q, true)", got, present, test.want)
			}
		})
	}
}

func TestResolveBrandEnvDeprecationAndConflictAreRedacted(t *testing.T) {
	events := make([]brandEnvDeprecationEvent, 0, 1)
	_, _, err := resolveBrandEnv(
		lookup(map[string]string{"OPC_API_KEY": "must-never-be-logged"}),
		"API_KEY",
		func(event brandEnvDeprecationEvent) { events = append(events, event) },
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].CurrentKey != "CONVERACT_API_KEY" || events[0].LegacyKey != "OPC_API_KEY" {
		t.Fatalf("unexpected deprecation event: %#v", events)
	}
	if strings.Contains(events[0].String(), "must-never-be-logged") {
		t.Fatal("deprecation event exposed a value")
	}

	_, _, err = resolveBrandEnv(
		lookup(map[string]string{
			"CONVERACT_API_KEY": "current-secret",
			"OPC_API_KEY":       "legacy-secret",
		}),
		"API_KEY",
		nil,
	)
	if err == nil {
		t.Fatal("expected a conflict")
	}
	if strings.Contains(err.Error(), "current-secret") || strings.Contains(err.Error(), "legacy-secret") {
		t.Fatal("conflict exposed a value")
	}
}
