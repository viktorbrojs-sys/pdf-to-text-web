import { createOcrWorker }       from './ocr.worker.js';
import { createTranslateWorker } from './translate.worker.js';
import { createExportWorker }    from './export.worker.js';

const workers = [
  createOcrWorker(),
  createTranslateWorker(),
  createExportWorker(),
];

console.log(`[workers] ${workers.length} workers running`);

async function shutdown(signal: string) {
  console.log(`[workers] ${signal} received, shutting down...`);
  await Promise.all(workers.map(w => w.close()));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
