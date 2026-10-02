/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', // Forces Next.js to build static HTML files
  basePath: '/openmukti-ai-watermark-remover', // Matches your GitHub repository name
  images: {
    unoptimized: true, // Required for static export
  },
};
module.exports = nextConfig;