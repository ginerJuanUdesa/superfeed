import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["100.110.66.122", "localhost", "192.168.1.43"],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
