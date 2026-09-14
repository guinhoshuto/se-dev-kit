import {withWorkflow} from 'workflow/next';

const config = {
  poweredByHeader: false,
  serverExternalPackages: ['playwright-core', '@vercel/sandbox'],
  webpack(config) {
    config.resolve.extensionAlias = {'.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs']};
    return config;
  },
  async headers() {
    return [{source: '/:path*', headers: [
      {key: 'Referrer-Policy', value: 'no-referrer'},
      {key: 'X-Content-Type-Options', value: 'nosniff'},
      {key: 'X-Robots-Tag', value: 'noindex, nofollow'},
      {key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()'}
    ]}];
  }
};
export default withWorkflow(config);
