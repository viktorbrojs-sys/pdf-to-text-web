import { Worker, Job as BullJob } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const { translate } = require('../lib/translate.js');

async function publishProgress(jobId: string, data: object) {
  await redis.publish(`job:${jobId}`, JSON.stringify(data));
}

async function processTranslateJob(bullJob: BullJob) {
  const { jobId, documentId, text, options } = bullJob.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: 'RUNNING', progress: 5 } });
  await publishProgress(jobId, { jobId, status: 'RUNNING', progress: 5, message: 'Начинаем перевод...' });

  const onProgress = async (p: { current: number; total: number; message?: string }) => {
    const pct = 5 + Math.round((p.current / p.total) * 90);
    await prisma.job.update({ where: { id: jobId }, data: { progress: pct } });
    await publishProgress(jobId, {
      jobId, status: 'RUNNING', progress: pct,
      message: p.message ?? `Часть ${p.current}/${p.total}`,
    });
  };

  const translated: string = await translate(text, {
    provider:    options.provider ?? 'ollama',
    model:       options.model,
    targetLang:  options.targetLang ?? 'ru',
    glossaryPath: options.glossaryPath,
    ollamaUrl:   process.env.OLLAMA_URL ?? 'http://localhost:11434',
    openaiKey:   process.env.OPENAI_API_KEY,
    deeplKey:    process.env.DEEPL_API_KEY,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
  }, onProgress);

  await prisma.document.update({
    where: { id: documentId },
    data: { translated, status: 'TRANSLATE_DONE' },
  });
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'DONE', progress: 100, finishedAt: new Date() },
  });

  await publishProgress(jobId, { jobId, status: 'DONE', progress: 100, message: 'Перевод завершён' });
}

export function createTranslateWorker() {
  const worker = new Worker('translate', processTranslateJob, {
    connection: redis,
    concurrency: Number(process.env.TRANSLATE_CONCURRENCY ?? 2),
  });

  worker.on('failed', async (job, err) => {
    console.error(`[translate-worker] Job ${job?.id} failed:`, err.message);
    if (job?.data?.jobId) {
      await prisma.job.update({
        where: { id: job.data.jobId },
        data: { status: 'FAILED', error: err.message, finishedAt: new Date() },
      });
      await prisma.document.update({
        where: { id: job.data.documentId },
        data: { status: 'ERROR' },
      });
      await publishProgress(job.data.jobId, {
        jobId: job.data.jobId, status: 'FAILED', progress: 0, error: err.message,
      });
    }
  });

  console.log('[translate-worker] started');
  return worker;
}
