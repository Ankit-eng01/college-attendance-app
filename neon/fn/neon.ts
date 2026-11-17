import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    sync: {
      name: "Attendify Sync API",
      source: "src/index.ts",
    },
    admin: {
      name: "Attendify Admin",
      source: "src/admin.ts",
      env: {
        ADMIN_TOKEN: { value: process.env.ADMIN_TOKEN, required: true },
      },
    },
  },
});
