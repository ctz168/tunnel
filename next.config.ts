import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // 生产模式监听 IPv6 dual-stack
  serverExternalPackages: [],
};

export default nextConfig;
