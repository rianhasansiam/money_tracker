import type { NextConfig } from "next";
import { buildApplicationHeaderRules } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": ["node_modules/@prisma/adapter-pg/**/*"],
  },
  poweredByHeader: false,
  async headers() {
    return buildApplicationHeaderRules(process.env);
  },
};

export default nextConfig;
