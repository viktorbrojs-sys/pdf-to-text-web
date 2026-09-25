const fs = require('fs');
const { execSync, spawn } = require('child_process');
const logger = require('./logger');
const { getOllamaUrl } = require('./ollama-setup');
const { getLMStudioUrl } = require('./lmstudio-setup');

const OLLAMA_TIMEOUT = 300000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

function isOllamaRunning() {
  try {
    const response = require('child_process').execSync(
      `curl -s -o /dev/null -w "%{http_code}" ${getOllamaUrl()}/api/tags`,
      { encoding: 'utf-8', timeout: 3000, stdio: 'ignore' }
    );
    return response.trim() === '200';
  } catch (e) {
    return false;
  }
}

// See scripts/ocr-ai.js for rationale — never pkill/respawn a local Ollama process when the
// active URL points at a remote server.
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
    return isOllamaRunning();
  }

  logger.info('Attempting Ollama restart from translate');
  try {
    execSync('pkill -f "ollama serve" || true', { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' });
  } catch (e) {}

  await new Promise(r => setTimeout(r, 1000));

  try {
    const { findOllamaBinary } = require('./ollama-setup');
    const bin = findOllamaBinary();
    const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    logger.error('Failed to spawn ollama serve', { error: e.message });
    return false;
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(isOllamaRunning());
    }, 3000);
  });
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
      throw new Error(`Request timed out after ${timeout / 1000}s. Ollama may be processing a large text.`);
    }
    throw error;
  }
}

/**
 * Translation Module
 * Supports: Ollama (local), OpenAI, DeepL, Anthropic
 */

// Default system prompt
const DEFAULT_SYSTEM_PROMPT = `Ты — профессиональный переводчик. Переведи текст с русского на английский язык.
Сохрани форматирование: заголовки, списки, таблицы.
Не переводи имена собственные, аббревиатуры и технические термины, если они не указаны в паттернах перевода.`;

/**
 * Load glossary patterns from CSV
 * @param {string} csvPath - Path to CSV file
 * @returns {Object} Pattern mappings
 */
function loadGlossary(csvPath) {
  if (!fs.existsSync(csvPath)) return {};
  
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const patterns = {};
  
  for (const line of lines) {
    const [source, target] = line.split(',').map(s => s.trim());
    if (source && target) {
      patterns[source] = target;
    }
  }
  
  return patterns;
}

/**
 * Save glossary patterns to CSV
 * @param {Object} patterns - Pattern mappings
 * @param {string} csvPath - Path to CSV file
 */
function saveGlossary(patterns, csvPath) {
  const lines = Object.entries(patterns).map(([k, v]) => `${k},${v}`);
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf-8');
}

/**
 * Apply glossary patterns to text before translation
 * @param {string} text - Source text
 * @param {Object} patterns - Pattern mappings
 * @returns {string} Text with patterns replaced
 */
function applyGlossary(text, patterns) {
  let result = text;
  for (const [source, target] of Object.entries(patterns)) {
    // Case-insensitive replacement
    const regex = new RegExp(source, 'gi');
    result = result.replace(regex, `[${target}]`);
  }
  return result;
}

/**
 * Restore glossary patterns after translation
 * @param {string} text - Translated text
 * @param {Object} patterns - Pattern mappings
 * @returns {string} Text with patterns restored
 */
function restoreGlossary(text, patterns) {
  if (!text || typeof text !== 'string') {
    return text || '';
  }
  let result = text;
  for (const [source, target] of Object.entries(patterns)) {
    // Remove brackets around translated terms
    const regex = new RegExp(`\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'g');
    result = result.replace(regex, target);
  }
  return result;
}

/**
 * Translate with Ollama (Local LLM)
 * @param {string} text - Text to translate
 * @param {Object} options - Options
 * @returns {Promise<string>} Translated text
 */
async function translateWithOllama(text, options = {}) {
  const { 
    model = 'llama3', 
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    glossary = {},
    temperature = 0.7,
    topP = 0.9,
    topK = 50,
    repeatPenalty = 1.1,
    numPredict = -1,
    // IMPORTANT: without an explicit num_ctx, Ollama falls back to the model's own configured
    // context length (from its Modelfile/GGUF metadata) — for some models (observed: Qwen3.5)
    // that default can be enormous (e.g. 262144), which on a remote/partially CPU-offloaded
    // server means allocating and processing a huge KV cache just to translate a short chunk of
    // text, easily blowing past OLLAMA_TIMEOUT. Always send a sane, user-controllable default.
    numCtx = 8192
  } = options;
  
  const processedText = applyGlossary(text, glossary);
  logger.info('Ollama translation request', { model, textLength: text.length, numCtx });
  
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Ollama translate attempt', { attempt, model });

      // Using /api/chat instead of /api/generate — deliberate. "Thinking" models (Qwen3/Qwen3.5,
      // DeepSeek-R1, etc.) generate an internal reasoning trace before the actual answer. Ollama's
      // /api/generate endpoint has a confirmed bug where `think: false` is silently ignored for
      // these models (ollama/ollama#14793): the model still burns its whole output budget on
      // thinking and the visible `response` field comes back empty — exactly the "Ollama returned
      // empty response. Model may not be loaded." symptom, even though the model loaded and ran
      // fine (just for 70-90s of unwanted reasoning). /api/chat honors `think: false` correctly
      // (must be a top-level request field, not inside `options`) and skips reasoning entirely,
      // which is both faster and reliable. This also fixes non-thinking models — /api/chat is the
      // strictly more capable, actively-maintained endpoint and `think: false` is a harmless no-op
      // for models that don't support it.
      const response = await fetchWithTimeout(`${getOllamaUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: processedText }
          ],
          think: false,
          stream: false,
          options: {
            temperature,
            top_p: topP,
            top_k: topK,
            repeat_penalty: repeatPenalty,
            num_predict: numPredict,
            num_ctx: numCtx
          }
        })
      }, OLLAMA_TIMEOUT);
    
      if (!response.ok) {
        throw new Error(`Ollama server error: ${response.status}`);
      }
    
      const data = await response.json();
      const content = data.message?.content;
    
      if (!content) {
        throw new Error('Ollama returned empty response. Model may not be loaded.');
      }
    
      logger.info('Ollama translate success', { attempt, model });
      return restoreGlossary(content, glossary);
    } catch (error) {
      lastError = error;
      logger.error('Ollama translate attempt failed', { attempt, error: error.message });

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

  throw new Error(`Ollama translation failed after ${MAX_RETRIES} attempts: ${lastError.message}. Start Ollama with: ollama serve`);
}

/**
 * Translate with OpenAI API
 * @param {string} text - Text to translate
 * @param {Object} options - Options
 * @returns {Promise<string>} Translated text
 */
async function translateWithOpenAI(text, options = {}) {
  const { 
    apiKey,
    model = 'gpt-4o',
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    glossary = {}
  } = options;
  
  if (!apiKey) throw new Error('OpenAI API key required');
  
  const processedText = applyGlossary(text, glossary);
  logger.info('OpenAI translation request', { model });
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: processedText }
        ],
        max_tokens: 8192
      })
    });
    
    const data = await response.json();
    
    if (data.error) throw new Error(data.error.message);
    
    return restoreGlossary(data.choices[0].message.content, glossary);
  } catch (error) {
    logger.error('OpenAI API error', { error: error.message });
    throw new Error(`OpenAI API error: ${error.message}`);
  }
}

/**
 * Translate with LM Studio's OpenAI-compatible local/remote server.
 * @param {string} text - Text to translate
 * @param {Object} options - Options
 * @returns {Promise<string>} Translated text
 */
async function translateWithLMStudio(text, options = {}) {
  const {
    apiKey,
    model,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    glossary = {},
    temperature = 0.7
  } = options;

  if (!model) throw new Error('Модель не выбрана. Загрузите модель в LM Studio и выберите её в списке.');

  const processedText = applyGlossary(text, glossary);
  logger.info('LM Studio translation request', { model, textLength: text.length });

  const headers = { 'Content-Type': 'application/json' };
  // Optional, unlike OpenAI — see ocrWithLMStudio in ocr-ai.js for the same reasoning.
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('LM Studio translate attempt', { attempt, model });

      const response = await fetchWithTimeout(`${getLMStudioUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: processedText }
          ],
          temperature
        })
      }, OLLAMA_TIMEOUT);

      if (!response.ok) {
        throw new Error(`LM Studio server error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('LM Studio returned empty response. Model may not be loaded.');
      }

      logger.info('LM Studio translate success', { attempt, model });
      return restoreGlossary(content, glossary);
    } catch (error) {
      lastError = error;
      logger.error('LM Studio translate attempt failed', { attempt, error: error.message });

      if (attempt < MAX_RETRIES) {
        logger.info('Retrying after delay...', { attempt, delay: RETRY_DELAY });
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue;
      }

      break;
    }
  }

  throw new Error(`LM Studio translation failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

/**
 * Translate with DeepL API
 * @param {string} text - Text to translate
 * @param {Object} options - Options
 * @returns {Promise<string>} Translated text
 */
async function translateWithDeepL(text, options = {}) {
  const { apiKey, glossary = {} } = options;
  
  if (!apiKey) throw new Error('DeepL API key required');
  
  const processedText = applyGlossary(text, glossary);
  logger.info('DeepL translation request');
  
  try {
    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: [processedText],
        target_lang: 'EN',
        source_lang: 'RU'
      })
    });
    
    const data = await response.json();
    
    if (data.message) throw new Error(data.message);
    
    return restoreGlossary(data.translations[0].text, glossary);
  } catch (error) {
    logger.error('DeepL API error', { error: error.message });
    throw new Error(`DeepL API error: ${error.message}`);
  }
}

/**
 * Translate with DeepSeek API
 * @param {string} text - Text to translate
 * @param {Object} options - Options
 * @returns {Promise<string>} Translated text
 */
async function translateWithDeepSeek(text, options = {}) {
  const {
    apiKey,
    model = 'deepseek-chat',
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    glossary = {}
  } = options;

  if (!apiKey) throw new Error('DeepSeek API key required');

  const processedText = applyGlossary(text, glossary);
  logger.info('DeepSeek translation request', { model });

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: processedText }
        ],
        max_tokens: 8192
      })
    });

    const data = await response.json();

    if (data.error) throw new Error(data.error.message);

    return restoreGlossary(data.choices[0].message.content, glossary);
  } catch (error) {
    logger.error('DeepSeek API error', { error: error.message });
    throw new Error(`DeepSeek API error: ${error.message}`);
  }
}

// Matches [Изображение: /path/to/image.png] and [Изображение: /path:x1,y1,x2,y2] markers —
// kept in sync with the identical regex in scripts/export.js, which is what actually turns
// these into embedded images at export time.
const IMAGE_MARKER_REGEX = /\[Изображение:\s*(.[^\]]*?)(?::(\d+),(\d+),(\d+),(\d+))?\]/g;

/**
 * Replace image markers with translation-safe placeholder tokens before sending text to a
 * translation provider. Image markers carry a Russian word ("Изображение") plus a filesystem
 * path — sent through an "translate Russian to English" request as-is, LLM/MT providers reliably
 * translate or reformat that word/path, which silently breaks image embedding downstream (export.js
 * requires the literal Cyrillic marker). Pure-ASCII, punctuation-free tokens have nothing for a
 * translator to "helpfully" act on and are reliably passed through untouched.
 * @param {string} text
 * @returns {{ protectedText: string, markers: string[] }}
 */
function protectImageMarkers(text) {
  const markers = [];
  const protectedText = text.replace(IMAGE_MARKER_REGEX, (match) => {
    const token = `IMGMARKERPLACEHOLDER${markers.length}`;
    markers.push(match);
    return token;
  });
  return { protectedText, markers };
}

/**
 * Restore the original image markers a translation provider was never shown.
 * @param {string} text
 * @param {string[]} markers - as produced by protectImageMarkers
 * @returns {string}
 */
function restoreImageMarkers(text, markers) {
  if (!markers.length || !text) return text;
  let result = text;
  markers.forEach((original, i) => {
    // Case-insensitive: some models lowercase/uppercase unrecognized tokens.
    const regex = new RegExp(`IMGMARKERPLACEHOLDER${i}`, 'gi');
    result = result.replace(regex, original);
  });
  return result;
}

/**
 * Split text into chunks of maxChunkSize characters, breaking at sentence boundaries
 */
function splitIntoChunks(text, maxChunkSize = 2000) {
  if (text.length <= maxChunkSize) return [text];
  
  const chunks = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }
    
    let splitIdx = -1;
    const searchArea = remaining.substring(0, maxChunkSize);
    
    // Try to split at sentence boundary
    const sentenceEnd = searchArea.lastIndexOf('. ');
    if (sentenceEnd > maxChunkSize * 0.5) {
      splitIdx = sentenceEnd + 1;
    } else {
      // Try newline
      const newline = searchArea.lastIndexOf('\n');
      if (newline > maxChunkSize * 0.3) {
        splitIdx = newline + 1;
      } else {
        // Force split at maxChunkSize
        splitIdx = maxChunkSize;
      }
    }
    
    chunks.push(remaining.substring(0, splitIdx).trim());
    remaining = remaining.substring(splitIdx).trim();
  }
  
  return chunks;
}

/**
 * Main translation function
 * @param {string} text - Text to translate
 * @param {Object} options - Options
 * @param {Function} onProgress - Progress callback (optional)
 * @returns {Promise<string>} Translated text
 */
async function translate(text, options = {}, onProgress = null) {
  const { provider = 'ollama', ...rest } = options;

  // Protect [Изображение: ...] markers (inserted by AI Vision / batch OCR) before chunking, so
  // that (a) the translation provider never sees — and can't mangle — the marker, and (b) a
  // marker can never be torn in half by a chunk boundary, since chunking now happens on the much
  // shorter placeholder token instead of the original marker text.
  const { protectedText, markers } = protectImageMarkers(text);

  const chunks = splitIntoChunks(protectedText, 2000);
  
  let result;
  if (chunks.length === 1) {
    result = await translateByProvider(provider, chunks[0], rest);
  } else {
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) {
        onProgress({ current: i + 1, total: chunks.length, message: `Переводим часть ${i + 1}/${chunks.length}...` });
      }
      const translated = await translateByProvider(provider, chunks[i], rest);
      results.push(translated);
    }
    result = results.join('\n\n');
  }

  result = restoreImageMarkers(result, markers);

  // Unload model to free VRAM after translation completes. Include a small num_ctx — without it,
  // Ollama loads the model at its own built-in default context (can be huge for some models)
  // just to immediately discard it, causing a needless multi-GB memory spike.
  if (provider === 'ollama' && rest.model) {
    try {
      const { isOllamaRunning } = require('./ollama-setup');
      if (await isOllamaRunning()) {
        await fetch(`${getOllamaUrl()}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: rest.model, keep_alive: 0, options: { num_ctx: rest.numCtx || 8192 } })
        });
      }
    } catch (e) {}
  }

  return result;
}

async function translateByProvider(provider, text, options) {
  switch (provider) {
    case 'ollama':
      return translateWithOllama(text, options);
    case 'openai':
      return translateWithOpenAI(text, options);
    case 'lmstudio':
      return translateWithLMStudio(text, options);
    case 'deepl':
      return translateWithDeepL(text, options);
    case 'deepseek':
      return translateWithDeepSeek(text, options);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

module.exports = {
  translate,
  translateWithOllama,
  translateWithOpenAI,
  translateWithLMStudio,
  translateWithDeepL,
  translateWithDeepSeek,
  loadGlossary,
  saveGlossary,
  protectImageMarkers,
  restoreImageMarkers,
  DEFAULT_SYSTEM_PROMPT
};
