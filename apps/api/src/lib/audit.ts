import { PrismaClient } from '@prisma/client';

export type AuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'UPLOAD'
  | 'OCR_START'
  | 'OCR_DONE'
  | 'TRANSLATE_START'
  | 'TRANSLATE_DONE'
  | 'EXPORT_DOWNLOAD'
  | 'ROLE_CHANGE'
  | 'SETTINGS_CHANGE'
  | 'DOCUMENT_DELETE';

export async function audit(
  prisma: PrismaClient,
  action: AuditAction,
  opts: {
    userId?: string;
    ip?: string;
    userAgent?: string;
    meta?: Record<string, unknown>;
  } = {},
) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId:    opts.userId,
        ip:        opts.ip,
        userAgent: opts.userAgent,
        meta:      opts.meta,
      },
    });
  } catch (err) {
    // Аудит не должен ронять основной запрос
    console.error('[audit] Failed to write log:', err);
  }
}
