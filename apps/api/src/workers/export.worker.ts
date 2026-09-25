import { Worker, Job as BullJob } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { Client as MinioClient } from 'minio';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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

const { exportToMarkdown, exportToDocx, exportToPdf } = require('../lib/export.js');

async function publishProgress(jobId: string, data: object) {
  await redis.publish(`job:${jobId}`, JSON.stringify(data));
}

const MIME: Record<string, string> = {
  md:   'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf:  'application/pdf',
};

async function processExportJob(bullJob: BullJob) {
  const { jobId, documentId, fileName, text, formats } = bullJob.data as {
    jobId: string;
    documentId: string;
    fileName: string;
    text: string;
    formats: ('md' | 'docx' | 'pdf')[];
  };

  await prisma.job.update({ where: { id: jobId }, data: { status: 'RUNNING', progress: 5 } });
  await publishProgress(jobId, { jobId, status: 'RUNNING', progress: 5, message: 'Подготовка экспорта...' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-export-'));
  const exportFns: Record<string, (text: string, outPath: string) => Promise<void>> = {
    md:   exportToMarkdown,
    docx: exportToDocx,
    pdf:  exportToPdf,
  };

  const total = formats.length;
  const exportRecords = [];

  try {
    for (let i = 0; i < formats.length; i++) {
      const fmt = formats[i];
      const pct = 10 + Math.round(((i) / total) * 85);

      await publishProgress(jobId, {
        jobId, status: 'RUNNING', progress: pct,
        message: `Экспорт ${fmt.toUpperCase()} (${i + 1}/${total})...`,
      });

      const outPath = path.join(tmpDir, `${fileName}.${fmt}`);
      await exportFns[fmt](text, outPath);

      const storagePath = `${documentId}/${fileName}.${fmt}`;
      const stat = fs.statSync(outPath);

      await minio.fPutObject('exports', storagePath, outPath, {
        'Content-Type': MIME[fmt],
      });

      exportRecords.push(
        await prisma.export.create({
          data: {
            documentId,
            format:      fmt,
            storagePath,
            sizeBytes:   stat.size,
          },
        }),
      );
    }

    await prisma.document.update({ where: { id: documentId }, data: { status: 'EXPORT_READY' } });
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'DONE', progress: 100, finishedAt: new Date() },
    });

    await publishProgress(jobId, {
      jobId, status: 'DONE', progress: 100,
      message: 'Экспорт завершён',
      exports: exportRecords,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function createExportWorker() {
  const worker = new Worker('export', processExportJob, {
    connection: redis,
    concurrency: Number(process.env.EXPORT_CONCURRENCY ?? 3),
  });

  worker.on('failed', async (job, err) => {
    console.error(`[export-worker] Job ${job?.id} failed:`, err.message);
    if (job?.data?.jobId) {
      await prisma.job.update({
        where: { id: job.data.jobId },
        data: { status: 'FAILED', error: err.message, finishedAt: new Date() },
      });
      await publishProgress(job.data.jobId, {
        jobId: job.data.jobId, status: 'FAILED', progress: 0, error: err.message,
      });
    }
  });

  console.log('[export-worker] started');
  return worker;
}
