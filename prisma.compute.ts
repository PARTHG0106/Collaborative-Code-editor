import { defineComputeConfig } from "@prisma/compute-sdk/config";

export default defineComputeConfig({
  apps: {
    "@collab/server": {
      root: "apps/server",
      framework: "bun",
      entry: "src/index.ts",
      httpPort: 4000,
    },
  },
});
