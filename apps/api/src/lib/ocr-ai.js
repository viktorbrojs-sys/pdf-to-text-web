const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const logger = require('./logger');
const { getOllamaUrl } = require('./ollama-setup');
const { getLMStudioUrl } = require('./lmstudio-setup');
let sharp;
try {
  sharp = require('sharp');
  // NOTE: version logging is intentionally outside the same try that catches load failures —
  // require('sharp/package.json') can itself throw under Node's "exports" map restrictions on
  // some versions, which would falsely report "sharp failed to load" even though `sharp` itself
  // loaded fine.
  let version = 'unknown';
  try {
    const sharpPkgPath = path.join(path.dirname(require.resolve('sharp')), '..', 'package.json');
    version = JSON.parse(fs.readFileSync(sharpPkgPath, 'utf-8')).version;
  } catch (e2) {}
  logger.info('sharp loaded successfully', { version });
} catch (e) {
  sharp = null;
  // If this fires in a packaged build, image cropping/embedding silently degrades everywhere
  // (coordinate markers get skipped instead of embedded) — see asarUnpack in package.json's
  // electron-builder config, which is what makes sharp's native binaries loadable at all from
  // inside a packaged app.
  logger.error('sharp failed to load — image cropping/embedding will be unavailable', { error: e.message });
}


const OLLAMA_TIMEOUT = 120000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

// Fallback: read model config from temp file (written by frontend before IPC call)
// This bypasses Electron IPC caching issues
const CONFIG_FILE = path.join(require('os').tmpdir(), 'pdf-to-text-ocr-config.json');

function writeOcrConfig(config) {
  // Don't save empty prompts — they break self-healing IPC
  if (!config.prompt || config.prompt.trim() === '') return;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config), 'utf-8'); } catch (e) {}
}

function readOcrConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      // Delete stale config with empty prompt
      if (!config.prompt || config.prompt.trim() === '') {
        try { fs.unlinkSync(CONFIG_FILE); } catch (e) {}
        return {};
      }
      return config;
    }
  } catch (e) {}
  return {};
}

function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

// Scale OCR coordinates from model's internal resolution to original image dimensions
async function scaleCoordinates(response, imagePath) {
  if (!response) return response;
  if (!sharp) {
    // Without sharp there is no way to read the original image's dimensions, so coordinates
    // stay in raw model-space (roughly 0-1000) instead of being scaled to real pixels — this
    // produces exactly the kind of severely misaligned/clustered bounding boxes reported (boxes
    // appearing shifted/shrunk into one corner), since raw model-space values get drawn directly
    // as if they were already real pixel coordinates on a much larger image.
    logger.warn('scaleCoordinates: sharp unavailable, coordinates left unscaled (raw model-space) — bounding boxes will be misaligned');
    return response;
  }

  const lines = response.split('\n');
  const coordRegex = /^(\w+)\s+\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\s*(.*)$/;

  // Filter out <PAGE> tags and find max coordinates
  let maxX = 0, maxY = 0;
  const filteredLines = [];
  for (const line of lines) {
    if (line.trim().startsWith('<PAGE>') || line.trim().startsWith('<|det|>')) continue;
    filteredLines.push(line);
    const m = line.match(coordRegex);
    if (m) {
      maxX = Math.max(maxX, parseInt(m[4]));
      maxY = Math.max(maxY, parseInt(m[5]));
    }
  }

  if (maxX === 0 || maxY === 0) {
    logger.info('scaleCoordinates: no coordinate lines found in response, nothing to scale');
    return filteredLines.join('\n');
  }

  // Get original image dimensions
  try {
    let imgW = 0, imgH = 0;

    if (sharp) {
      const meta = await sharp(imagePath).metadata();
      imgW = meta.width;
      imgH = meta.height;
    } else if (process.platform === 'darwin') {
      // Fallback: use macOS sips to get image dimensions
      try {
        const sipsOutput = require('child_process').execSync(
          `sips -g pixelWidth -g pixelHeight "${imagePath}"`, { encoding: 'utf-8', timeout: 5000 }
        );
        const wMatch = sipsOutput.match(/pixelWidth:\s*(\d+)/);
        const hMatch = sipsOutput.match(/pixelHeight:\s*(\d+)/);
        if (wMatch) imgW = parseInt(wMatch[1]);
        if (hMatch) imgH = parseInt(hMatch[1]);
      } catch (e2) {}
    }

    if (!imgW || !imgH) {
      logger.warn('Could not read image dimensions for scaling', { imagePath });
      return filteredLines.join('\n');
    }

    // Model processing size depends on mode:
    // Gundam (image): image_size=640, crop_mode=True
    // Base (PDF): image_size=1024, crop_mode=False
    // Model processing size: both modes use ~1024, tuned for Ollama preprocessing
    const MODEL_SIZE = 1000;
    const scaleX = imgW / MODEL_SIZE;
    const scaleY = imgH / MODEL_SIZE;

    // If scale is close to 1 (0.9-1.1), coordinates are already correct
    if (scaleX > 0.9 && scaleX < 1.1 && scaleY > 0.9 && scaleY < 1.1) {
      logger.info('scaleCoordinates: scale close to 1, leaving coordinates as-is', { imgW, imgH, scaleX: scaleX.toFixed(2), scaleY: scaleY.toFixed(2) });
      return filteredLines.join('\n');
    }

    // Scale all coordinates from model space (1024) to original image space
    logger.info('Scaling OCR coordinates', { maxX, maxY, imgW, imgH, scaleX: scaleX.toFixed(2), scaleY: scaleY.toFixed(2) });

    const scaled = filteredLines.map(line => {
      const m = line.match(coordRegex);
      if (m) {
        const x1 = Math.round(parseInt(m[2]) * scaleX);
        const y1 = Math.round(parseInt(m[3]) * scaleY);
        const x2 = Math.round(parseInt(m[4]) * scaleX);
        const y2 = Math.round(parseInt(m[5]) * scaleY);
        return `${m[1]} [${x1},${y1},${x2},${y2}]${m[6]}`;
      }
      return line;
    }).join('\n');

    return scaled;
  } catch (e) {
    logger.warn('Failed to get image dimensions for coordinate scaling', { error: e.message });
    return filteredLines.join('\n');
  }
}

// Detect garbage/looping text from VRAM exhaustion
function isGarbageText(text) {
  if (!text || text.length < 100) return false;
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 5) return false;
  // Check if >60% of lines are identical or very similar
  const counts = {};
  for (const line of lines.slice(0, 50)) {
    const key = line.trim().substring(0, 30);
    counts[key] = (counts[key] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(counts));
  return maxCount > lines.length * 0.3;
}

async function isOllamaRunning() {
  try {
    const response = await fetch(`${getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch (e) {
    return false;
  }
}

async function getInstalledModels() {
  try {
    const response = await fetch(`${getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map(m => m.name);
  } catch (e) {
    return [];
  }
}

// Only true when the current Ollama URL points at this machine. A remote URL means there is
// no local process to "restart" — pkill/spawn would be a no-op for connectivity and could kill
// an unrelated local Ollama instance, which is what previously made remote setups fail silently
// after a transient network hiccup (the app would "fix" the wrong server).
function isLocalOllamaUrl(url) {
  try {
    const { hostname } = new URL(url || getOllamaUrl());
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname);
  } catch (e) {
    return true;
  }
}

async function restartOllama() {
  const currentUrl = getOllamaUrl();

  if (!isLocalOllamaUrl(currentUrl)) {
    logger.info('Skipping local Ollama restart — a remote URL is active', { url: currentUrl });
    await new Promise(r => setTimeout(r, 1500));
    return await isOllamaRunning();
  }

  logger.info('Attempting Ollama restart from ocr-ai');
  try {
    execSync('pkill -f "ollama serve" || true', { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' });
  } catch (e) {}

  await new Promise(r => setTimeout(r, 1000));

  try {
    const { findOllamaBinary } = require('./ollama-setup');
    const bin = findOllamaBinary();
    const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (e) {
    logger.error('Failed to spawn ollama serve', { error: e.message });
    return false;
  }

  await new Promise(r => setTimeout(r, 3000));
  return await isOllamaRunning();
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout / 1000}s. Ollama may be overloaded or the model is too large.`);
    }
    throw error;
  }
}

async function ocrWithOllama(imagePath, options = {}) {
  logger.info('ocrWithOllama called with options:', JSON.stringify(options));
  
  let { model = '', prompt = 'Извлеки весь текст с этого изображения. Сохрани форматирование.', repeatPenalty = 'off' } = options;

  // Use default prompt if empty (frontend may send empty string)
  if (!prompt || prompt.trim() === '') {
    prompt = model.includes('unlimited-ocr') ? '<image>document parsing.' : 'Извлеки весь текст с этого изображения. Сохрани форматирование.';
  }

  // Build Ollama options
  const ollamaOptions = {};
  if (repeatPenalty && repeatPenalty !== 'off') {
    ollamaOptions.repeat_penalty = parseFloat(repeatPenalty);
  }

  // Auto-select vision model if not specified (IPC caching workaround)
  if (!model || model === '') {
    const visionModels = ['qwen3-vl', 'llama3.2-vision', 'minicpm-v', 'gemma3', 'llava', 'granite3.2-vision', 'glm-ocr', 'bakllava', 'moondream'];
    const installed = await getInstalledModels();
    for (const vm of visionModels) {
      const found = installed.find(m => m.startsWith(vm));
      if (found) {
        model = found;
        break;
      }
    }
    if (!model) {
      throw new Error('Модель не выбрана и не найдена подходящая vision-модель. Установите модель: ollama pull qwen3-vl:4b');
    }
  }

  logger.info('ocrWithOllama model:', model);

  const installedModels = await getInstalledModels();
  if (!installedModels.some(m => m.startsWith(model.split(':')[0]))) {
    logger.error('Model not installed:', { requested: model, available: installedModels });
    throw new Error(`Model ${model} is not installed. Available: ${installedModels.join(', ')}`);
  }

  // Compress large images (PNG→JPG, or re-encode JPG with lower quality)
  let processedImagePath = imagePath;
  const threshold = options.compressThreshold || 1024; // KB
  const quality = options.compressQuality || 95;
  // Skip compression if file is already compressed (has _compressed in name)
  const alreadyCompressed = imagePath.includes('_compressed');
  if (sharp && options.compressImages !== false && !alreadyCompressed) {
    try {
      const stats = fs.statSync(imagePath);
      if (stats.size > threshold * 1024) {
        const tmpDir = __dirname.includes('.asar')
          ? path.join(require('os').tmpdir(), 'pdf-to-text', 'compressed')
          : path.join(__dirname, '..', 'input', 'compressed');
        fs.mkdirSync(tmpDir, { recursive: true });
        const jpgPath = path.join(tmpDir, path.basename(imagePath).replace(/\.(png|jpe?g)$/i, '') + '_compressed.jpg');
        await sharp(imagePath).jpeg({ quality }).toFile(jpgPath);
        processedImagePath = jpgPath;
        logger.info('Image compression', { original: imagePath, jpg: jpgPath, originalSize: stats.size, jpgSize: fs.statSync(jpgPath).size });
      }
    } catch (e) {
      logger.warn('Image compression failed, using original', { error: e.message });
    }
  }

  const base64 = imageToBase64(processedImagePath);
  let lastError = null;
  // 4096 was the previous default here specifically for unlimited-ocr models — smaller than the
  // 16000 fallback used for everything else, despite the model being marketed for exactly the
  // dense/long-document case where a small context truncates output. num_ctx covers the image
  // encoding + prompt + generated text combined; on a dense A4 page this silently cut the
  // response roughly in half with no visible error (confirmed: a page with clearly several
  // thousand more characters than what came back). Raised to line up with the general default.
  let ctxSize = options.numCtx || (model.includes('unlimited-ocr') ? 16384 : 16000);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Ollama OCR attempt', { attempt, model, imageSize: base64.length, numCtx: ctxSize });

      const ollamaOpts = { ...ollamaOptions, num_ctx: ctxSize };
      if (options.temperature && options.temperature > 0) {
        ollamaOpts.temperature = options.temperature;
      }
      const requestBody = { model, prompt, images: [base64], stream: false, options: ollamaOpts };

      // Longer timeout for Unlimited OCR (model is larger)
      const timeout = model.includes('unlimited-ocr') ? 300000 : OLLAMA_TIMEOUT;

      const response = await fetchWithTimeout(`${getOllamaUrl()}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }, timeout);

      const data = await response.json();
      logger.info('Ollama OCR response', { response: data.response?.substring(0, 200), model, done: data.done, totalDuration: data.total_duration });

      // Detect CUDA OOM in response
      const isCudaOom = (data.error || '').includes('out of memory') || (data.error || '').includes('CUDA');
      if (isCudaOom && ctxSize > 2048) {
        ctxSize = Math.floor(ctxSize / 2);
        logger.warn('CUDA OOM detected, reducing num_ctx', { newCtx: ctxSize, attempt });
        lastError = new Error(`CUDA OOM — уменьшаю контекст до ${ctxSize}`);
        continue;
      }

      // Detect garbage/looping text from VRAM exhaustion during generation
      if (data.response && isGarbageText(data.response) && ctxSize > 2048) {
        ctxSize = Math.floor(ctxSize / 2);
        logger.warn('Garbage text detected (VRAM exhaustion), reducing num_ctx', { newCtx: ctxSize, attempt, responseLen: data.response.length });
        lastError = new Error(`VRAM exhaustion — текст зациклен. Уменьшаю контекст до ${ctxSize}`);
        continue;
      }

      if (!data.response || data.response.trim() === '') {
        logger.warn('Empty response from /api/generate', { model, imageDataLength: base64.length, error: data.error });

        // Try /api/chat endpoint (recommended for vision models)
        const chatResponse = await fetchWithTimeout(`${getOllamaUrl()}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{
              role: 'user',
              content: 'Extract all text from this image. Preserve formatting. Output only the extracted text, no comments.',
              images: [base64]
            }],
            stream: false,
            // IMPORTANT: without this, Ollama falls back to the model's own built-in default
            // context window (262144 for qwen3-vl) instead of the size actually configured —
            // this is what caused memory to balloon to ~44GB whenever the primary /api/generate
            // call returned an empty response and this fallback kicked in.
            options: ollamaOpts
          })
        }, timeout);

        const chatData = await chatResponse.json();
        const chatText = chatData.message?.content || '';
        logger.info('/api/chat response', { response: chatText.substring(0, 200), error: chatData.error });

        // Detect model crash (EOF) or CUDA OOM — reduce context and retry
        const chatError = (chatData.error || '').toLowerCase();
        const isChatCudaOom = chatError.includes('out of memory') || chatError.includes('cuda') || chatError.includes('unexpected eof');
        if (isChatCudaOom && ctxSize > 2048) {
          ctxSize = Math.floor(ctxSize / 2);
          logger.warn('Model crash/OOM in /api/chat, reducing num_ctx', { newCtx: ctxSize, attempt, error: chatData.error });
          lastError = new Error(`VRAM exhaustion — уменьшаю контекст до ${ctxSize}`);
          continue;
        }

        if (chatText.trim()) {
          let chatFinalText = await scaleCoordinates(chatText, imagePath);
          if (chatData.done_reason === 'length') {
            chatFinalText += `\n\n[⚠ Текст обрезан — достигнут лимит контекста (num_ctx=${ctxSize}). Увеличьте "Контекст" в настройках и распознайте страницу заново.]`;
          }
          return chatFinalText;
        }

        // Last resort: try English prompt with /api/generate
        const englishPrompt = 'Extract all text from this image. Preserve formatting.';
        logger.info('Trying with English prompt', { model });

        const englishResponse = await fetchWithTimeout(`${getOllamaUrl()}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: englishPrompt,
            images: [base64],
            stream: false,
            // Same reasoning as the /api/chat fallback above — must not omit num_ctx.
            options: ollamaOpts
          })
        }, timeout);

        const englishData = await englishResponse.json();
        logger.info('English prompt response', { response: englishData.response?.substring(0, 100) });

        if (englishData.response) {
          return await scaleCoordinates(englishData.response, imagePath);
        }
        throw new Error('Model returned empty response. The model may not support vision input.');
      }

      logger.info('Ollama OCR success', { attempt, model, doneReason: data.done_reason });
      let finalText = await scaleCoordinates(data.response, imagePath);
      // done_reason === 'length' means Ollama stopped because num_ctx (prompt + image tokens +
      // generated output, combined) was exhausted — NOT because the model naturally finished.
      // On a dense page this silently cuts the output roughly in half with no visible error,
      // which is exactly what was reported: recognized text much shorter than what's on the
      // scan. Surface it so it's obvious what happened instead of looking like a quality issue.
      if (data.done_reason === 'length') {
        logger.warn('Response truncated: num_ctx exhausted', { model, ctxSize });
        finalText += `\n\n[⚠ Текст обрезан — достигнут лимит контекста (num_ctx=${ctxSize}). Увеличьте "Контекст" в настройках и распознайте страницу заново.]`;
      }
      return finalText;
    } catch (error) {
      lastError = error;
      logger.error('Ollama OCR attempt failed', { attempt, error: error.message });

      // CUDA OOM in exception — reduce context and retry
      const isCudaOomError = error.message.includes('out of memory') || error.message.includes('CUDA');
      if (isCudaOomError && ctxSize > 2048) {
        ctxSize = Math.floor(ctxSize / 2);
        logger.warn('CUDA OOM in exception, reducing num_ctx', { newCtx: ctxSize, attempt });
        if (attempt < MAX_RETRIES) continue;
      }

      const isConnectionError = error.message.includes('fetch failed') ||
                                 error.message.includes('ECONNREFUSED') ||
                                 error.message.includes('ECONNRESET');

      if (isConnectionError && attempt < MAX_RETRIES) {
        logger.info('Connection error, attempting Ollama restart...', { attempt });
        const restarted = await restartOllama();
        if (restarted) {
          logger.info('Ollama restarted, retrying...');
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue;
        }
      }

      if (attempt < MAX_RETRIES) {
        logger.info('Retrying after delay...', { attempt, delay: RETRY_DELAY });
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue;
      }

      break;
    }
  }

  throw new Error(`Ollama OCR failed после ${MAX_RETRIES} попыток: ${lastError.message}. Размер изображения: ${Math.round(base64.length * 0.75 / 1024)}KB. Убедитесь что Ollama запущен и модель поддерживает vision. Попробуйте: ollama pull qwen3-vl:4b`);
}

async function ocrWithOpenAI(imagePath, options = {}) {
  const { apiKey, model = 'gpt-4o', prompt = 'Извлеки весь текст с этого изображения. Сохрани форматирование.' } = options;
  
  if (!apiKey) throw new Error('OpenAI API key required');
  
  const base64 = imageToBase64(imagePath);
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
          ]
        }],
        max_tokens: 4096
      })
    });
    
    const data = await response.json();
    
    if (data.error) throw new Error(data.error.message);
    
    return data.choices[0].message.content;
  } catch (error) {
    throw new Error(`OpenAI API error: ${error.message}`);
  }
}

async function ocrWithLMStudio(imagePath, options = {}) {
  const { apiKey, model, prompt = 'Извлеки весь текст с этого изображения. Сохрани форматирование.', temperature, numCtx } = options;

  if (!model) throw new Error('Модель не выбрана. Загрузите vision-модель в LM Studio и выберите её в списке.');

  const base64 = imageToBase64(imagePath);
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  try {
    const headers = { 'Content-Type': 'application/json' };
    // LM Studio's local server normally has no auth at all; a key is only relevant for people
    // proxying a remote LM Studio behind something that checks one, so it stays optional here
    // (unlike OpenAI, where it's mandatory) — see ocrWithOpenAI above for the contrast.
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }],
      max_tokens: 4096
    };
    if (temperature && temperature > 0) body.temperature = temperature;
    // LM Studio's OpenAI-compatible server accepts context-length-adjacent knobs differently
    // per backend (llama.cpp vs MLX); n_ctx isn't part of the standard chat/completions schema,
    // so unlike Ollama's num_ctx there's no reliable universal request field for it — context
    // size for LM Studio is a load-time setting the person configures in the LM Studio UI itself.

    const response = await fetchWithTimeout(`${getLMStudioUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, OLLAMA_TIMEOUT);

    const data = await response.json();

    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('LM Studio вернул пустой ответ. Проверьте, что модель загружена в LM Studio.');

    // Scale coordinates from model-space (0-1000 range) to real image pixels — same
    // transformation ocrWithOllama does on every return path. Without this call the bounding
    // boxes from any model that outputs coordinates (Qwen3-VL, etc.) are drawn directly in
    // model-space coordinates (e.g. max ~1000) on an image that may be several thousand pixels
    // wide, so they all cluster into a tiny corner of the document (exactly the "все бокcы
    // поплыли" symptom reported when switching Unlimited OCR / AI Vision to LM Studio).
    return await scaleCoordinates(text, imagePath);
  } catch (error) {
    throw new Error(`LM Studio error: ${error.message}`);
  }
}

async function ocrWithGoogleVision(imagePath, options = {}) {
  const { apiKey } = options;
  
  if (!apiKey) throw new Error('Google Vision API key required');
  
  const base64 = imageToBase64(imagePath);
  
  try {
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: base64 },
            features: [{ type: 'TEXT_DETECTION', maxResults: 10 }]
          }]
        })
      }
    );
    
    const data = await response.json();
    
    if (data.error) throw new Error(data.error.message);
    
    return data.responses[0]?.fullTextAnnotation?.text || '';
  } catch (error) {
    throw new Error(`Google Vision API error: ${error.message}`);
  }
}

async function ocrWithAI(imagePath, options = {}) {
  // If options are empty (IPC caching issue), read from temp config file
  if (!options.provider && !options.model) {
    const config = readOcrConfig();
    if (config.model) {
      options = config;
    }
  }

  const { provider = 'ollama', ...rest } = options;
  
  switch (provider) {
    case 'ollama':
      return ocrWithOllama(imagePath, rest);
    case 'openai':
      return ocrWithOpenAI(imagePath, rest);
    case 'lmstudio':
      return ocrWithLMStudio(imagePath, rest);
    case 'google':
      return ocrWithGoogleVision(imagePath, rest);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function processMultipleImages(imagePaths, options = {}, onProgress = () => {}) {
  const texts = [];
  
  for (let i = 0; i < imagePaths.length; i++) {
    onProgress(i + 1, imagePaths.length, Math.round((i / imagePaths.length) * 100));
    
    const text = await ocrWithAI(imagePaths[i], options);
    texts.push(text);
  }
  
  return texts.join('\n\n');
}

async function unloadOcrModel(model, numCtx) {
  try {
    if (!model) return;
    const { isOllamaRunning } = require('./ollama-setup');
    if (!await isOllamaRunning()) return;
    await fetch(`${getOllamaUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // IMPORTANT: always include num_ctx here, even though we're only unloading. Ollama loads
      // the model according to the request's parameters before honoring keep_alive: 0 — if
      // num_ctx is omitted, it falls back to the model's OWN built-in default context window
      // (e.g. 262144 for qwen3-vl), briefly reloading the model at that huge size just to
      // immediately discard it. That produced the multi-GB memory spikes seen right after each
      // OCR run (8192 → ~44GB → 8192). Reusing the small context actually used for OCR avoids
      // the spike entirely.
      body: JSON.stringify({ model, keep_alive: 0, options: { num_ctx: numCtx || 2048 } })
    });
    logger.info('OCR model unloaded', { model, numCtx: numCtx || 2048 });
  } catch (e) {}
}

module.exports = {
  ocrWithAI,
  ocrWithOllama,
  ocrWithOpenAI,
  ocrWithLMStudio,
  ocrWithGoogleVision,
  processMultipleImages,
  readOcrConfig,
  unloadOcrModel
};
