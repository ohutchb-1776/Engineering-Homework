import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app proxies City of Portland ArcGIS requests through its own route
  // handlers (src/app/api/analyze), so it needs a Node server. Do not switch
  // this to `output: "export"` without replacing that proxy.
  reactStrictMode: true,
  // No remote images are rendered; keeping the optimizer off removes `sharp`
  // from the runtime surface.
  images: { unoptimized: true },
};

export default nextConfig;
