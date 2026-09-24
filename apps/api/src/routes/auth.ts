import { FastifyInstance } from 'fastify';
import * as openidClient from 'openid-client';
import { audit } from '../lib/audit.js';

export default async function authRoutes(fastify: FastifyInstance) {
  // GET /auth/login — redirect to Keycloak
  fastify.get('/auth/login', async (req, reply) => {
    const state = Math.random().toString(36).slice(2);
    const url = fastify.oidc.authorizationUrl({
      scope: 'openid email profile',
      state,
    });
    reply.setCookie('oidc_state', state, { httpOnly: true, sameSite: 'lax', path: '/' });
    return reply.redirect(url);
  });

  // GET /auth/callback — Keycloak redirects here after login
  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;

      if (error) {
        return reply.redirect(`/?error=${encodeURIComponent(error)}`);
      }

      const savedState = req.cookies?.oidc_state;
      if (!state || state !== savedState) {
        return reply.status(400).send({ error: 'Invalid state' });
      }

      const params = fastify.oidc.callbackParams(req.raw);
      const tokenSet = await fastify.oidc.callback(
        `${process.env.APP_URL}/auth/callback`,
        params,
        { state },
      );

      const claims = tokenSet.claims();

      // Upsert пользователя в БД
      const user = await fastify.prisma.user.upsert({
        where: { keycloakId: claims.sub },
        create: {
          keycloakId: claims.sub,
          email:      claims.email ?? '',
          username:   (claims.preferred_username ?? claims.sub) as string,
          department: (claims as any).department,
        },
        update: {
          email:      claims.email ?? '',
          username:   (claims.preferred_username ?? claims.sub) as string,
          department: (claims as any).department,
        },
      });

      await audit(fastify.prisma, 'LOGIN', {
        userId:    user.id,
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
        meta:      { username: user.username },
      });

      // Устанавливаем httpOnly cookie с access_token
      reply.setCookie('access_token', tokenSet.access_token!, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 8, // 8 часов
      });

      reply.clearCookie('oidc_state');
      return reply.redirect('/');
    },
  );

  // POST /auth/logout
  fastify.post('/auth/logout', {
    preHandler: fastify.authenticate,
  }, async (req, reply) => {
    await audit(fastify.prisma, 'LOGOUT', {
      userId:    (req as any).user?.sub,
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
    });

    reply.clearCookie('access_token', { path: '/' });

    const logoutUrl = fastify.oidc.endSessionUrl({
      post_logout_redirect_uri: process.env.APP_URL,
    });

    return reply.send({ logoutUrl });
  });

  // GET /auth/me — текущий пользователь
  fastify.get('/auth/me', {
    preHandler: fastify.authenticate,
  }, async (req) => {
    const dbUser = await fastify.prisma.user.findUnique({
      where: { keycloakId: req.user.sub },
      select: { id: true, username: true, email: true, department: true, role: true, createdAt: true },
    });
    return dbUser ?? req.user;
  });
}
