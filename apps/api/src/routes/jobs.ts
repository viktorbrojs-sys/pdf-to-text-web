import { FastifyInstance } from 'fastify';
import { OcrOptions, TranslateOptions } from '../types/index.js';

export default async function jobRoutes(fastify: FastifyInstance) {
  const auth = { preHandler: fastify.authenticate };

  // POST /api/documents/:id/ocr
  fastify.post<{ Params: { id: string }; Body: OcrOptions }>(
    '/api/documents/:id/ocr', auth,
    async (req, reply) => {
      const doc = await fastify.prisma.document.findUnique({ where: { id: req.params.id } });
      if (!doc) return reply.status(404).send({ error: 'Not found' });

      const user = await fastify.prisma.user.findUnique({ where: { keycloakId: req.user.sub } });
      if (!user || (doc.userId !== user.id && req.user.role === 'USER')) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      // Создаём запись Job в БД
      const job = await fastify.prisma.job.create({
        data: { documentId: doc.id, type: 'OCR', status: 'QUEUED' },
      });

      // Ставим в очередь BullMQ
      const bullJob = await fastify.queues.ocr.add('ocr', {
        jobId:       job.id,
        documentId:  doc.id,
        storagePath: doc.storagePath,
        options:     req.body,
      });

      // Сохраняем bullJobId
      await fastify.prisma.job.update({
        where: { id: job.id },
        data:  { bullJobId: bullJob.id?.toString(), status: 'RUNNING' },
      });

      await fastify.prisma.document.update({
        where: { id: doc.id },
        data:  { status: 'OCR_PENDING', ocrMethod: req.body.method },
      });

      return reply.status(202).send({ jobId: job.id, bullJobId: bullJob.id });
    },
  );

  // POST /api/documents/:id/translate
  fastify.post<{ Params: { id: string }; Body: TranslateOptions }>(
    '/api/documents/:id/translate', auth,
    async (req, reply) => {
      const doc = await fastify.prisma.document.findUnique({ where: { id: req.params.id } });
      if (!doc) return reply.status(404).send({ error: 'Not found' });
      if (!doc.ocrText) return reply.status(400).send({ error: 'Run OCR first' });

      const user = await fastify.prisma.user.findUnique({ where: { keycloakId: req.user.sub } });
      if (!user || (doc.userId !== user.id && req.user.role === 'USER')) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const job = await fastify.prisma.job.create({
        data: { documentId: doc.id, type: 'TRANSLATE', status: 'QUEUED' },
      });

      const bullJob = await fastify.queues.translate.add('translate', {
        jobId:      job.id,
        documentId: doc.id,
        text:       doc.ocrText,
        options:    req.body,
      });

      await fastify.prisma.job.update({
        where: { id: job.id },
        data:  { bullJobId: bullJob.id?.toString(), status: 'RUNNING' },
      });

      await fastify.prisma.document.update({
        where: { id: doc.id },
        data:  { status: 'TRANSLATE_PENDING', language: req.body.targetLang },
      });

      return reply.status(202).send({ jobId: job.id });
    },
  );

  // GET /api/jobs/:jobId — статус задачи
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId', auth,
    async (req, reply) => {
      const job = await fastify.prisma.job.findUnique({ where: { id: req.params.jobId } });
      if (!job) return reply.status(404).send({ error: 'Not found' });
      return job;
    },
  );

  // WS /ws/jobs/:jobId — live-прогресс (замена IPC onProgress)
  fastify.get<{ Params: { jobId: string } }>(
    '/ws/jobs/:jobId',
    { websocket: true, ...auth },
    async (connection, req) => {
      const { jobId } = req.params;
      const sub = fastify.redis.duplicate();

      await sub.subscribe(`job:${jobId}`);

      sub.on('message', (_channel, message) => {
        if (connection.socket.readyState === 1 /* OPEN */) {
          connection.socket.send(message);
        }
      });

      // Отправляем текущий статус сразу
      const job = await fastify.prisma.job.findUnique({ where: { id: jobId } });
      if (job && connection.socket.readyState === 1) {
        connection.socket.send(JSON.stringify({
          jobId,
          status:   job.status,
          progress: job.progress,
        }));
      }

      connection.socket.on('close', () => {
        sub.unsubscribe();
        sub.quit();
      });
    },
  );
}
