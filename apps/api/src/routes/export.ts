import { FastifyInstance } from 'fastify';
import { audit } from '../lib/audit.js';

export default async function exportRoutes(fastify: FastifyInstance) {
  const auth = { preHandler: fastify.authenticate };

  // POST /api/documents/:id/export — постановка в очередь
  fastify.post<{
    Params: { id: string };
    Body: { formats: ('md' | 'docx' | 'pdf')[] };
  }>('/api/documents/:id/export', auth, async (req, reply) => {
    const doc = await fastify.prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return reply.status(404).send({ error: 'Not found' });

    const text = doc.translated ?? doc.ocrText;
    if (!text) return reply.status(400).send({ error: 'No text to export' });

    const user = await fastify.prisma.user.findUnique({ where: { keycloakId: req.user.sub } });
    if (!user || (doc.userId !== user.id && req.user.role === 'USER')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const job = await fastify.prisma.job.create({
      data: { documentId: doc.id, type: 'EXPORT', status: 'QUEUED' },
    });

    const bullJob = await fastify.queues.export.add('export', {
      jobId:      job.id,
      documentId: doc.id,
      fileName:   doc.fileName.replace('.pdf', ''),
      text,
      formats:    req.body.formats ?? ['md', 'docx', 'pdf'],
    });

    await fastify.prisma.job.update({
      where: { id: job.id },
      data:  { bullJobId: bullJob.id?.toString(), status: 'RUNNING' },
    });

    return reply.status(202).send({ jobId: job.id });
  });

  // GET /api/documents/:id/exports — список экспортов документа
  fastify.get<{ Params: { id: string } }>(
    '/api/documents/:id/exports', auth,
    async (req, reply) => {
      const doc = await fastify.prisma.document.findUnique({ where: { id: req.params.id } });
      if (!doc) return reply.status(404).send({ error: 'Not found' });

      return fastify.prisma.export.findMany({
        where:   { documentId: doc.id },
        orderBy: { createdAt: 'desc' },
      });
    },
  );

  // GET /api/exports/:exportId/download — скачать через presigned URL (24ч)
  fastify.get<{ Params: { exportId: string } }>(
    '/api/exports/:exportId/download', auth,
    async (req, reply) => {
      const exp = await fastify.prisma.export.findUnique({ where: { id: req.params.exportId } });
      if (!exp) return reply.status(404).send({ error: 'Not found' });

      const user = await fastify.prisma.user.findUnique({ where: { keycloakId: req.user.sub } });

      const presignedUrl = await fastify.minio.presignedGetObject(
        'exports',
        exp.storagePath,
        60 * 60 * 24, // 24 часа
      );

      await audit(fastify.prisma, 'EXPORT_DOWNLOAD', {
        userId: user?.id,
        ip:     req.ip,
        meta:   { exportId: exp.id, format: exp.format, documentId: exp.documentId },
      });

      // Редиректим на presigned URL — браузер скачивает напрямую из MinIO
      return reply.redirect(presignedUrl);
    },
  );
}
