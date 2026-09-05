import { defineConfig } from "vitest/config";

// Anchors vitest to this directory so it doesn't wander up the tree and pick
// up unrelated vite configs. Tests must stay hermetic: no external API calls.
export default defineConfig({
  test: {},
});
