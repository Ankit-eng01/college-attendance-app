import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    sync: {
      name: "Attendify Sync API",
      source: "src/index.ts",
      env: {
        ACCOUNT_TOKEN_SECRET: {
          value: process.env.ACCOUNT_TOKEN_SECRET,
          required: true,
        },
      },
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
