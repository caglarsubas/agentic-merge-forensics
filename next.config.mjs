/** @type {import('next').NextConfig} */
const nextConfig = {
  // The engine shells out to git/gh and reads the clone cache from disk, so it
  // must stay on the Node runtime rather than the edge runtime.
  serverExternalPackages: [],
  eslint: { ignoreDuringBuilds: false },
};
export default nextConfig;
