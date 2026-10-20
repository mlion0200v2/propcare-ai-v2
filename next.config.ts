import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Self-contained server for the Cloud Run container (see Dockerfile).
  output: "standalone",
};

export default nextConfig;
