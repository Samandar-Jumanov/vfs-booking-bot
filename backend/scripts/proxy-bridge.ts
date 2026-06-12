import { Server } from 'proxy-chain';

const upstreamProxyUrl = process.env.UPSTREAM_PROXY_URL;
const port = Number(process.env.LOCAL_PROXY_PORT || '18080');

if (!upstreamProxyUrl) {
  console.error('UPSTREAM_PROXY_URL is required');
  process.exit(2);
}

const server = new Server({
  host: '127.0.0.1',
  port,
  prepareRequestFunction: () => ({
    requestAuthentication: false,
    upstreamProxyUrl,
  }),
});

server.listen(() => {
  console.log(`PROXY_BRIDGE_READY http://127.0.0.1:${server.port}`);
  console.log(`UPSTREAM ${upstreamProxyUrl.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@')}`);
});

server.on('requestFailed', ({ request, error }) => {
  console.error(`PROXY_BRIDGE_REQUEST_FAILED ${request.url} ${error.message}`);
});

process.on('SIGINT', async () => {
  await server.close(true);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.close(true);
  process.exit(0);
});
