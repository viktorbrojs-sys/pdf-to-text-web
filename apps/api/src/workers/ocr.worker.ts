import { Worker, Job as BullJob } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Client as MinioClient } from 'minio';

const prisma = new PrismaClient();
const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const minio = new MinioClient({
  endPoint:  process.env.MINIO_ENDPOINT  ?? 'localhost',
  port:      Number(process.env.MINIO_PORT ?? 9000),
  useSSL:    process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
});

// Динамический импорт JS-модулей (CommonJS из scripts/)
const { ocrWithAI } = require('../lib/ocr-ai.js');
const { extractText } = require('../lib/ocr-textpdf.js');
const { runOcr } = require('../lib/ocr.js');

async function publishProgress(jobId: string, data: object) {
  await redis.publish(`job:${jobId}`, JSON.stringify(data));
}

async function processOcrJob(bullJob: BullJob) {
  const { jobId, documentId, storagePath, options } = bullJob.data;

  await publishProgress(jobId, { jobId, status: 'RUNNING', progress: 5, message: 'Загрузка файла...' });
  await prisma.job.update({ where: { id: jobId }, data: { status: 'RUNNING', progress: 5 } });

  // Скачиваем PDF из MinIO во временный файл
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-'));
  const tmpPdf = path.join(tmpDir, 'input.pdf');

  const stream = await minio.getObject('documents', storagePath);
  await new Promise<void>((res, rej) => {
    const ws = fs.createWriteStream(tmpPdf);
    stream.pipe(ws);
    ws.on('finish', res);
    ws.on('error', rej);
  });

  await publishProgress(jobId, { jobId, status: 'RUNNING', progress: 15, message: 'Файл получен, запуск OCR...' });

  let text = '';

  try {
    const onProgress = async (p: { current: number; total: number; message?: string }) => {
      const pct = 15 + Math.round((p.current / p.total) * 75);
      await prisma.job.update({ where: { id: jobId }, data: { progress: pct } });
      await publishProgress(jobId, {
        jobId, status: 'RUNNING', progress: pct,
        message: p.message ?? `Страница ${p.current}/${p.total}`,
      });
    };

    if (options.method === 'textpdf') {
      text = await extractText(tmpPdf);
    } else if (options.method === 'ai' || options.method === 'unlimited') {
      text = await ocrWithAI(tmpPdf, {
        ...options,
        onProgress,
        ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
      });
    } else {
      // tesseract
      text = await runOcr(tmpPdf, { lang: options.language ?? 'rus', onProgress });
    }

    // Сохраняем результат в БД
    await prisma.document.update({
      where: { id: documentId },
      data: { ocrText: text, status: 'OCR_DONE', ocrMethod: options.method },
    });
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'DONE', progress: 100, finishedAt: new Date() },
    });

    await publishProgress(jobId, { jobId, status: 'DONE', progress: 100, message: 'OCR завершён' });
  } finally {
    // Чистим временные файлы
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function createOcrWorker() {
  const worker = new Worker('ocr', processOcrJob, {
    connection: redis,
    concurrency: Number(process.env.OCR_CONCURRENCY ?? 2),
  });

  worker.on('failed', async (job, err) => {
    console.error(`[ocr-worker] Job ${job?.id} failed:`, err.message);
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

  console.log('[ocr-worker] started');
  return worker;
}
