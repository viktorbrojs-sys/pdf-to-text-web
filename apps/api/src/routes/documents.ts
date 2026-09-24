import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { audit } from '../lib/audit.js';

export default async function documentRoutes(fastify: FastifyInstance) {
  const auth = { preHandler: fastify.authenticate };

  // POST /api/documents/upload — multipart PDF
  fastify.post('/api/documents/upload', auth, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'No file provided' });

    if (data.mimetype !== 'application/pdf') {
      return reply.status(400).send({ error: 'Only PDF files are accepted' });
    }

    const user = await fastify.prisma.user.findUnique({
      where: { keycloakId: req.user.sub },
    });
    if (!user) return reply.status(401).send({ error: 'User not found' });

    const fileId = randomUUID();
    const storagePath = `${user.id}/${fileId}.pdf`;

    // Стримим напрямую в MinIO
    await fastify.minio.putObject(
      'documents',
      storagePath,
      data.file,
      { 'Content-Type': 'application/pdf', 'X-Original-Name': data.filename },
    );

    const doc = await fastify.prisma.document.create({
      data: {
        userId:      user.id,
        fileName:    data.filename,
        storagePath,
        status:      'UPLOADED',
      },
    });

    await audit(fastify.prisma, 'UPLOAD', {
      userId:    user.id,
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
      meta:      { fileName: data.filename, docId: doc.id },
    });

    return reply.status(201).send(doc);
  });

  // GET /api/documents — список документов текущего пользователя
  // MANAGER видит свой отдел, ADMIN — всех
  fastify.get('/api/documents', auth, async (req) => {
    const user = await fastify.prisma.user.findUnique({
      where: { keycloakId: req.user.sub },
    });
    if (!user) return [];

    if (req.user.role === 'ADMIN') {
      return fastify.prisma.document.findMany({
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { username: true, department: true } }, jobs: true },
      });
    }

    if (req.user.role === 'MANAGER' && user.department) {
      return fastify.prisma.document.findMany({
        where: { user: { department: user.department } },
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { username: true, department: true } }, jobs: true },
      });
    }

    // USER — только свои
    return fastify.prisma.document.findMany({
      where:   { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { jobs: true },
    });
  });

  // GET /api/documents/:id
  fastify.get<{ Params: { id: string } }>('/api/documents/:id', auth, async (req, reply) => {
    const doc = await fastify.prisma.document.findUnique({
      where: { id: req.params.id },
      include: { jobs: true, exports: true },
    });
    if (!doc) return reply.status(404).send({ error: 'Not found' });

    const user = await fastify.prisma.user.findUnique({ where: { keycloakId: req.user.sub } });
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    // Проверяем доступ
    if (req.user.role !== 'ADMIN' && doc.userId !== user.id) {
      if (req.user.role !== 'MANAGER') {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    }

    return doc;
  });

  // DELETE /api/documents/:id
  fastify.delete<{ Params: { id: string } }>('/api/documents/:id', auth, async (req, reply) => {
    const doc = await fastify.prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return reply.status(404).send({ error: 'Not found' });

    const user = await fastify.prisma.user.findUnique({ where: { keycloakId: req.user.sub } });
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    if (req.user.role !== 'ADMIN' && doc.userId !== user.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Удаляем из MinIO
    try {
      await fastify.minio.removeObject('documents', doc.storagePath);
    } catch { /* файл мог быть уже удалён */ }

    await fastify.prisma.document.delete({ where: { id: doc.id } });

    await audit(fastify.prisma, 'DOCUMENT_DELETE', {
      userId: user.id,
      ip:     req.ip,
      meta:   { docId: doc.id, fileName: doc.fileName },
    });

    return reply.status(204).send();
  });
}
