import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    sync: {
      name: "Attendify Sync API",
      source: "src/index.ts",
    },
  },
});
