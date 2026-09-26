import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';

import dbPlugin    from './plugins/db.js';
import queuePlugin from './plugins/queue.js';
import minioPlugin from './plugins/minio.js';
import authPlugin  from './plugins/auth.js';

import healthRoutes    from './routes/health.js';
import authRoutes      from './routes/auth.js';
import documentRoutes  from './routes/documents.js';
import jobRoutes       from './routes/jobs.js';
import exportRoutes    from './routes/export.js';
import adminRoutes     from './routes/admin.js';

const isDev = process.env.NODE_ENV !== 'production';

const fastify = Fastify({
  logger: isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : true,
});

async function start() {
  // ── Security ──
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // настраивается на nginx уровне
  });
  await fastify.register(cors, {
    origin: process.env.APP_URL ?? 'http://localhost:5173',
    credentials: true,
  });
  await fastify.register(cookie, {
    secret: process.env.COOKIE_SECRET ?? 'change-me-in-production',
  });
  await fastify.register(multipart, {
    limits: {
      fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024), // 50 MB
    },
  });
  await fastify.register(websocket);

  // ── Infrastructure plugins ──
  await fastify.register(dbPlugin);
  await fastify.register(queuePlugin);
  await fastify.register(minioPlugin);
  await fastify.register(authPlugin);

  // ── Routes ──
  await fastify.register(healthRoutes);
  await fastify.register(authRoutes);
  await fastify.register(documentRoutes);
  await fastify.register(jobRoutes);
  await fastify.register(exportRoutes);
  await fastify.register(adminRoutes);

  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 3001);

  await fastify.listen({ host, port });
  fastify.log.info(`API server listening on http://${host}:${port}`);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
