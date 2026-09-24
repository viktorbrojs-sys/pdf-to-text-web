import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as openidClient from 'openid-client';
import { JwtPayload, Role } from '../types/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

// Keycloak role → internal Role mapping
function extractRole(tokenClaims: Record<string, unknown>): Role {
  const realmRoles =
    ((tokenClaims as any)?.realm_access?.roles as string[] | undefined) ?? [];
  if (realmRoles.includes('ADMIN'))   return 'ADMIN';
  if (realmRoles.includes('MANAGER')) return 'MANAGER';
  return 'USER';
}

export default fp(async (fastify: FastifyInstance) => {
  const issuerUrl = `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}`;

  // openid-client v5 API
  const issuer = await openidClient.Issuer.discover(issuerUrl);

  const client = new issuer.Client({
    client_id:     process.env.KEYCLOAK_CLIENT_ID     ?? 'pdf-to-text-api',
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
    redirect_uris: [`${process.env.APP_URL}/auth/callback`],
    response_types: ['code'],
  });

  // Decorator — проверяет JWT из cookie или Authorization header
  fastify.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const token =
        req.cookies?.['access_token'] ??
        req.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      // Верифицируем через Keycloak JWKS
      const payload = await client.introspect(token);
      if (!payload.active) {
        return reply.status(401).send({ error: 'Token expired' });
      }

      req.user = {
        sub:        payload.sub as string,
        email:      payload.email as string,
        username:   (payload.preferred_username ?? payload.sub) as string,
        department: (payload as any).department as string | undefined,
        role:       extractRole(payload as Record<string, unknown>),
      };
    } catch (err) {
      fastify.log.warn({ err }, 'Auth failed');
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // Хелпер requireRole — вызывается как preHandler
  fastify.decorate('requireRole', (minRole: Role) => {
    const order: Role[] = ['USER', 'MANAGER', 'ADMIN'];
    return async (req: FastifyRequest, reply: FastifyReply) => {
      await (fastify as any).authenticate(req, reply);
      if (reply.sent) return;
      if (order.indexOf(req.user.role) < order.indexOf(minRole)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    };
  });

  // Сохраняем OIDC-client для роутов /auth/*
  fastify.decorate('oidc', client);

  fastify.log.info(`Keycloak OIDC configured: ${issuerUrl}`);
});

// Расширяем типы Fastify
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole:  (role: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    oidc:         openidClient.BaseClient;
  }
}
