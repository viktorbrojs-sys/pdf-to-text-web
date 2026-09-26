import { FastifyInstance } from 'fastify';
import { Role } from '../types/index.js';
import { audit } from '../lib/audit.js';

export default async function adminRoutes(fastify: FastifyInstance) {
  const adminOnly = { preHandler: fastify.requireRole('ADMIN') };

  // ── Users ────────────────────────────────────────────────────────────────

  // GET /api/admin/users
  fastify.get('/api/admin/users', adminOnly, async (req) => {
    return fastify.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, keycloakId: true, username: true,
        email: true, department: true, role: true, createdAt: true,
        _count: { select: { documents: true } },
      },
    });
  });

  // PATCH /api/admin/users/:id/role
  fastify.patch<{
    Params: { id: string };
    Body: { role: Role };
  }>('/api/admin/users/:id/role', adminOnly, async (req, reply) => {
    const { role } = req.body;
    if (!['USER', 'MANAGER', 'ADMIN'].includes(role)) {
      return reply.status(400).send({ error: 'Invalid role' });
    }

    const updated = await fastify.prisma.user.update({
      where: { id: req.params.id },
      data: { role },
      select: { id: true, username: true, email: true, role: true },
    });

    const requester = await fastify.prisma.user.findUnique({
      where: { keycloakId: req.user.sub },
    });
    await audit(fastify.prisma, 'ROLE_CHANGE', {
      userId: requester?.id,
      ip: req.ip,
      meta: { targetUserId: req.params.id, newRole: role },
    });

    return updated;
  });

  // ── Audit log ─────────────────────────────────────────────────────────────

  // GET /api/admin/logs?action=LOGIN&userId=...&from=2024-01-01&to=2024-12-31&limit=100&offset=0
  fastify.get<{
    Querystring: {
      action?: string;
      userId?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/admin/logs', adminOnly, async (req) => {
    const { action, userId, from, to, limit = '100', offset = '0' } = req.query;

    const where: Record<string, unknown> = {};
    if (action)  where.action = action;
    if (userId)  where.userId = userId;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to   ? { lte: new Date(to)   } : {}),
      };
    }

    const [total, logs] = await Promise.all([
      fastify.prisma.auditLog.count({ where }),
      fastify.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:   Math.min(Number(limit), 500),
        skip:   Number(offset),
        include: { user: { select: { username: true, department: true } } },
      }),
    ]);

    return { total, logs };
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────

  // GET /api/admin/jobs?status=FAILED&type=OCR&limit=50
  fastify.get<{
    Querystring: { status?: string; type?: string; limit?: string; offset?: string };
  }>('/api/admin/jobs', adminOnly, async (req) => {
    const { status, type, limit = '50', offset = '0' } = req.query;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (type)   where.type   = type;

    const [total, jobs] = await Promise.all([
      fastify.prisma.job.count({ where }),
      fastify.prisma.job.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Number(limit), 200),
        skip: Number(offset),
        include: {
          document: { select: { fileName: true, user: { select: { username: true } } } },
        },
      }),
    ]);

    return { total, jobs };
  });

  // POST /api/admin/jobs/:id/retry — перезапуск упавшего job'а
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/jobs/:id/retry', adminOnly,
    async (req, reply) => {
      const job = await fastify.prisma.job.findUnique({
        where: { id: req.params.id },
        include: { document: true },
      });
      if (!job)              return reply.status(404).send({ error: 'Job not found' });
      if (job.status !== 'FAILED') return reply.status(400).send({ error: 'Only FAILED jobs can be retried' });

      // Создаём новый job того же типа
      const newJob = await fastify.prisma.job.create({
        data: { documentId: job.documentId, type: job.type, status: 'QUEUED' },
      });

      const queueMap = {
        OCR:       fastify.queues.ocr,
        TRANSLATE: fastify.queues.translate,
        EXPORT:    fastify.queues.export,
      } as const;

      await queueMap[job.type].add(job.type.toLowerCase(), {
        jobId:      newJob.id,
        documentId: job.documentId,
        storagePath: job.document.storagePath,
      });

      return { retryJobId: newJob.id };
    },
  );

  // ── Statistics ────────────────────────────────────────────────────────────

  // GET /api/admin/stats
  fastify.get('/api/admin/stats', adminOnly, async () => {
    const [
      totalUsers,
      totalDocuments,
      totalJobs,
      failedJobs,
      jobsByType,
      recentErrors,
    ] = await Promise.all([
      fastify.prisma.user.count(),
      fastify.prisma.document.count(),
      fastify.prisma.job.count(),
      fastify.prisma.job.count({ where: { status: 'FAILED' } }),
      fastify.prisma.job.groupBy({ by: ['type'], _count: { id: true } }),
      fastify.prisma.job.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, type: true, error: true, createdAt: true,
          document: { select: { fileName: true } } },
      }),
    ]);

    return {
      users:       { total: totalUsers },
      documents:   { total: totalDocuments },
      jobs: {
        total: totalJobs,
        failed: failedJobs,
        byType: Object.fromEntries(jobsByType.map(r => [r.type, r._count.id])),
      },
      recentErrors,
    };
  });

  // ── System settings ───────────────────────────────────────────────────────

  // GET /api/admin/settings
  fastify.get('/api/admin/settings', adminOnly, async () => {
    const rows = await fastify.prisma.systemSetting.findMany();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  });

  // PATCH /api/admin/settings
  fastify.patch<{ Body: Record<string, string> }>(
    '/api/admin/settings', adminOnly,
    async (req, reply) => {
      const entries = Object.entries(req.body);
      if (!entries.length) return reply.status(400).send({ error: 'No settings provided' });

      await fastify.prisma.$transaction(
        entries.map(([key, value]) =>
          fastify.prisma.systemSetting.upsert({
            where:  { key },
            create: { key, value },
            update: { value },
          }),
        ),
      );

      const requester = await fastify.prisma.user.findUnique({
        where: { keycloakId: req.user.sub },
      });
      await audit(fastify.prisma, 'SETTINGS_CHANGE', {
        userId: requester?.id,
        ip: req.ip,
        meta: { keys: Object.keys(req.body) },
      });

      return { updated: entries.length };
    },
  );
}
