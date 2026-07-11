import { defineComputeConfig } from "@prisma/compute-sdk/config";

export default defineComputeConfig({
  apps: {
    "collaborative-code-editor": {
      root: "apps/server",
      framework: "bun",
      entry: "src/index.ts",
    },
  },
});
