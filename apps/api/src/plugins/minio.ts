import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Client as MinioClient } from 'minio';

declare module 'fastify' {
  interface FastifyInstance {
    minio: MinioClient;
  }
}

const BUCKETS = ['documents', 'exports'] as const;

export default fp(async (fastify: FastifyInstance) => {
  const minio = new MinioClient({
    endPoint:  process.env.MINIO_ENDPOINT  ?? 'localhost',
    port:      Number(process.env.MINIO_PORT ?? 9000),
    useSSL:    process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  });

  // Создаём бакеты если не существуют
  for (const bucket of BUCKETS) {
    const exists = await minio.bucketExists(bucket);
    if (!exists) {
      await minio.makeBucket(bucket);
      fastify.log.info(`MinIO bucket created: ${bucket}`);
    }
  }

  fastify.decorate('minio', minio);
  fastify.log.info('MinIO connected');
});
