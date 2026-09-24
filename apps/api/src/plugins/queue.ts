import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    redis: IORedis;
    queues: {
      ocr: Queue;
      translate: Queue;
      export: Queue;
    };
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });

  redis.on('connect', () => fastify.log.info('Redis connected'));
  redis.on('error', (err) => fastify.log.error({ err }, 'Redis error'));

  const connection = { connection: redis };

  const queues = {
    ocr:       new Queue('ocr',       connection),
    translate: new Queue('translate', connection),
    export:    new Queue('export',    connection),
  };

  fastify.decorate('redis', redis);
  fastify.decorate('queues', queues);

  fastify.addHook('onClose', async () => {
    await Promise.all(Object.values(queues).map(q => q.close()));
    await redis.quit();
  });
});
