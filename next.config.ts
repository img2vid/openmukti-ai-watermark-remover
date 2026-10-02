import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export', // REQUIRED for GitHub Pages
  
  // Change this to match your actual repository name! 
  // Based on your logs, it might be 'openmukti-ai-watermark-remover'
  basePath: '/openmukti-ai-watermark-remover', 
  
  images: {
    unoptimized: true, // REQUIRED for static export
  },
  
  // If Prisma still throws type errors during the build, uncomment the lines below:
  // typescript: {
  //   ignoreBuildErrors: true,
  // },
};

export default nextConfig;
