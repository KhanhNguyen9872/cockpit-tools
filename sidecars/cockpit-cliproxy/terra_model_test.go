package main

import (
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
)

func TestGPT61TerraCatalog(t *testing.T) {
	if !isCodexShellModelID("gpt-6.1-terra") || officialAutomaticModelDisplayName("gpt-6.1-terra") != "GPT-6.1 Terra" {
		t.Fatal("Terra must be recognized as an official model")
	}
	found := false
	for _, model := range registry.GetCodexPlusModels() {
		if model.ID == "gpt-6.1-terra" {
			found = true
			if model.MaxCompletionTokens != 128000 || model.ContextLength != ollamaContextLength(model.ID) {
				t.Fatalf("unexpected Terra limits: %#v", model)
			}
		}
	}
	if !found {
		t.Fatal("Terra missing from paid model registry")
	}
	response := buildCodexClientModelsResponse([]string{"gpt-6.1-terra"}, &apiKeySpec{}, nil, nil)
	models, ok := response["models"].([]map[string]any)
	if !ok {
		t.Fatal("missing client models")
	}
	model := findCodexClientModelForTest(models, "gpt-6.1-terra")
	if model == nil || model["display_name"] != "GPT-6.1 Terra" {
		t.Fatalf("missing client model: %#v", model)
	}
}
