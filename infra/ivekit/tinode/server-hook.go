package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	tinodeowner "ivekit.local/tinodeowner"

	"github.com/tinode/chat/server/logs"
)

var ivekitTopicOwners *tinodeowner.Registry

func ivekitUseStableClusterNodeID(clusterSelf *string) error {
	nodeID := strings.TrimSpace(os.Getenv("IVEKIT_COMPONENT_NODE_ID"))
	if nodeID == "" {
		return nil
	}
	if clusterSelf == nil {
		return errors.New("ivekit Tinode cluster_self pointer is nil")
	}
	if current := strings.TrimSpace(*clusterSelf); current != "" && current != nodeID {
		return errors.New("ivekit Tinode cluster_self does not match component node ID")
	}
	*clusterSelf = nodeID
	return nil
}

func ivekitInitTopicOwners(mux *http.ServeMux) error {
	if mux == nil {
		return errors.New("ivekit Tinode HTTP mux is required")
	}
	registry, err := tinodeowner.NewRegistryFromEnv()
	if err != nil {
		return err
	}
	handler, err := tinodeowner.NewHTTPHandlerFromEnv(registry)
	if err != nil {
		return err
	}
	ivekitTopicOwners = registry
	if handler != nil {
		mux.Handle("/ivekit/v1/topics/prepare", handler)
	}
	return registry.Start(func(topicName string, ownerErr error) {
		logs.Err.Printf("ivekit topic owner lost: topic=%s err=%v", topicName, ownerErr)
		if globals.hub == nil {
			return
		}
		select {
		case globals.hub.unreg <- &topicUnreg{rcptTo: topicName}:
		default:
			logs.Err.Printf("ivekit topic owner shutdown queue full: topic=%s", topicName)
		}
	})
}

func ivekitStopTopicOwners() {
	if ivekitTopicOwners != nil {
		ivekitTopicOwners.Stop()
	}
}

func ivekitOpenTopicOwner(topic *Topic, now time.Time) error {
	if ivekitTopicOwners == nil || topic == nil || topic.isProxy ||
		!strings.HasPrefix(topic.name, "grp") {
		return nil
	}
	_, hasPlacement, err := tinodeowner.ParseTrustedPlacement(topic.trusted)
	if err != nil {
		return err
	}
	if !hasPlacement && !ivekitTopicOwners.IsManaged(topic.name) {
		return nil
	}
	_, err = ivekitTopicOwners.OpenOrAssert(
		context.Background(),
		topic.name,
		topic.trusted,
		now,
	)
	return err
}

func ivekitAssertTopicOwner(topic *Topic, now time.Time) error {
	if ivekitTopicOwners == nil || topic == nil || topic.isProxy ||
		!ivekitTopicOwners.IsManaged(topic.name) {
		return nil
	}
	return ivekitTopicOwners.Assert(topic.name, now)
}

func ivekitCloseTopicOwner(topicName string) {
	if ivekitTopicOwners == nil || !ivekitTopicOwners.IsManaged(topicName) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := ivekitTopicOwners.Close(ctx, topicName); err != nil {
		logs.Err.Printf("ivekit topic owner close failed: topic=%s err=%v", topicName, err)
	}
}
