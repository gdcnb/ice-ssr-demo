/** @type {import('next').NextConfig} */
const nextConfig = {
  // 孤立的子项目，明确 tracing 根目录，避免 Next 误认父级的 pnpm-lock.yaml
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
