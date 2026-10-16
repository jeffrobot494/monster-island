import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
export const LAN_TOKEN = Math.random().toString(36).slice(2, 10);
export function allowed(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('::ffff:127.') ||
    req.headers['x-dev-ai-token'] === LAN_TOKEN
  );
}
export function devPlugin(): Plugin {
  return {
    name: 'island-dev-tools',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.info(`[dev] LAN token: ?token=${LAN_TOKEN}`);
      server.middlewares.use('/dev-ai/delay', (req, res) => {
        const ms = Math.max(
          0,
          Math.min(
            900000,
            Number(new URL(req.url ?? '', 'http://x').searchParams.get('ms')) ||
              0,
          ),
        );
        setTimeout(() => {
          res.setHeader('content-type', 'image/svg+xml');
          res.end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
          );
        }, ms);
      });
    },
  };
}
