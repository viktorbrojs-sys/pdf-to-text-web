import { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    // Проверяем доступность БД
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
    } catch {
      return { status: 'error', db: 'unavailable' };
    }
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      uptime: Math.floor(process.uptime()),
    };
  });

  fastify.get('/health/ready', async (_, reply) => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      return reply.send({ ready: true });
    } catch {
      return reply.status(503).send({ ready: false });
    }
  });
}
