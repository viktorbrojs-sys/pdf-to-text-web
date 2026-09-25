const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Ollama Setup Module
 * Auto-detects OS, checks/installs Ollama, manages models
 */

let _ollamaUrl = 'http://localhost:11434';

function getOllamaUrl() { return _ollamaUrl; }

/**
 * Normalizes a user-entered Ollama base URL: trims whitespace, strips a trailing slash, and
 * strips a mistakenly-appended `/v1` or `/api` suffix. This app talks to Ollama's native API
 * (`/api/tags`, `/api/generate`, `/api/pull`, ...), not the OpenAI-compatible `/v1/...` endpoint
 * that Ollama also exposes — appending `/v1` (a common mix-up) silently breaks every request
 * (they'd hit e.g. `.../v1/api/tags`, a 404) with no obvious error pointing back at the URL.
 */
function normalizeOllamaUrl(url) {
  let u = (url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/(v1|api)$/i, '');
  return u;
}

function setOllamaUrl(url) { _ollamaUrl = normalizeOllamaUrl(url); }

const RECOMMENDED_MODELS = [
  { name: 'qwen2.5:7b', size: '4.7GB', description: 'Отличное для русского языка' },
  { name: 'llama3.1:8b', size: '4.7GB', description: 'Хорошее общее качество' },
  { name: 'mistral:7b', size: '4.1GB', description: 'Быстрое, среднее качество' },
  { name: 'gemma2:9b', size: '5.4GB', description: 'Отличное, но больше размер' }
];

const DEFAULT_MODEL = 'qwen2.5:7b';

/**
 * Find ollama binary path — checks common install locations
 */
function findOllamaBinary() {
  const platform = os.platform();
  const candidates = ['ollama'];
  if (platform === 'darwin') {
    candidates.unshift(
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
      path.join(os.homedir(), '.ollama/bin/ollama')
    );
  } else if (platform === 'linux') {
    candidates.unshift('/usr/local/bin/ollama', '/usr/bin/ollama');
  }
  for (const bin of candidates) {
    try {
      if (bin === 'ollama') {
        execSync('command -v ollama', { encoding: 'utf-8', stdio: 'ignore' });
        return 'ollama';
      }
      if (fs.existsSync(bin)) return bin;
    } catch (e) {}
  }
  return 'ollama'; // fallback
}

/**
 * Get OS type
 */
function getOsType() {
  const platform = os.platform();
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

/**
 * Check if Ollama is installed (CLI or HTTP API)
 */
function isOllamaInstalled() {
  // First check HTTP API (works even in packaged Electron on macOS)
  try {
    // Sync check using child_process to avoid async issues
    execSync(`curl -s -o /dev/null -w "%{http_code}" ${getOllamaUrl()}/api/tags`, {
      encoding: 'utf-8', timeout: 3000, stdio: 'ignore'
    });
    return true;
  } catch (e) {}
  // Fallback: try CLI
  try {
    const bin = findOllamaBinary();
    execSync(`"${bin}" --version`, { encoding: 'utf-8', stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Check if Ollama server is running (via HTTP API)
 */
async function isOllamaRunning() {
  try {
    const response = await fetch(`${getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(10000) });
    return response.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Start Ollama server
 */
function startOllamaServer() {
  return new Promise((resolve, reject) => {
    const bin = findOllamaBinary();
    const child = spawn(bin, ['serve'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    
    // Wait a bit for server to start
    setTimeout(() => {
      isOllamaRunning().then(ok => {
        if (ok) {
          resolve(true);
        } else {
          reject(new Error('Failed to start Ollama server'));
        }
      }).catch(() => reject(new Error('Failed to start Ollama server')));
    }, 3000);
  });
}

/**
 * Install Ollama
 */
async function installOllama(onProgress = () => {}) {
  const osType = getOsType();
  
  onProgress('Установка Ollama...');
  
  try {
    if (osType === 'linux' || osType === 'macos') {
      execSync('curl -fsSL https://ollama.com/install.sh | sh', { 
        encoding: 'utf-8',
        timeout: 300000 // 5 minutes
      });
    } else if (osType === 'windows') {
      throw new Error('Для Windows скачайте Ollama с https://ollama.com/download');
    }
    
    onProgress('Ollama установлен!');
    return true;
  } catch (error) {
    throw new Error(`Ошибка установки Ollama: ${error.message}`);
  }
}

/**
 * Get list of installed models (via HTTP API)
 */
async function getInstalledModels() {
  try {
    const response = await fetch(`${getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map(m => ({
      name: m.name,
      size: m.size ? `${Math.round(m.size / 1024 / 1024 / 1024 * 10) / 10}GB` : '',
      modified: m.modified_at || ''
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Check if model is installed
 */
async function isModelInstalled(modelName) {
  const models = await getInstalledModels();
  return models.some(m => m.name === modelName || m.name.startsWith(modelName.split(':')[0]));
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[\?[0-9]*[a-z]/g, '');
}

function parsePullProgress(cleaned) {
  const progress = { percent: null, downloaded: null, total: null, speed: null, eta: null };

  const pctMatch = cleaned.match(/(\d+)%/);
  if (pctMatch) progress.percent = parseInt(pctMatch[1], 10);

  const sizeMatch = cleaned.match(/([\d.]+\s*[KMG]B)\s*\/\s*([\d.]+\s*[KMG]B)/i);
  if (sizeMatch) {
    progress.downloaded = sizeMatch[1].trim();
    progress.total = sizeMatch[2].trim();
  }

  const speedMatch = cleaned.match(/([\d.]+\s*[KMG]B\/s)/i);
  if (speedMatch) progress.speed = speedMatch[1].trim();

  const etaMatch = cleaned.match(/(\d+[smhd]\d*[smhd]?|\d+[smhd])/);
  if (etaMatch) progress.eta = etaMatch[1].trim();

  return progress;
}

/**
 * Pull model with progress — via Ollama's HTTP API (POST /api/pull), NOT the local CLI.
 *
 * The previous implementation always spawned the local `ollama` binary
 * (`spawn(findOllamaBinary(), ['pull', modelName])`), completely ignoring the configured
 * getOllamaUrl(). When connected to a remote server, clicking "download" in the UI would pull
 * the model onto the LOCAL machine instead of the remote one — the remote server would still be
 * missing the model, so it kept getting offered as "not installed" no matter how many times the
 * user "downloaded" it. Using the HTTP API instead makes this work correctly for both local and
 * remote Ollama instances, matching the same URL used for every other request.
 */
async function pullModel(modelName, onProgress = () => {}) {
  const response = await fetch(`${getOllamaUrl()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: true })
  });

  if (!response.ok || !response.body) {
    let detail = '';
    try { detail = await response.text(); } catch (e) {}
    throw new Error(`Failed to pull model: HTTP ${response.status}${detail ? ' — ' + detail : ''}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lastStatus = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const part of parts) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      try {
        const json = JSON.parse(cleaned);
        lastStatus = json;
        if (json.error) throw new Error(json.error);
        if (json.status) {
          const pct = json.completed != null && json.total
            ? Math.round((json.completed / json.total) * 100)
            : null;
          onProgress({ status: json.status, percent: pct, downloaded: json.completed, total: json.total });
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // partial/non-JSON line, ignore
        throw e;
      }
    }
  }

  if (lastStatus && lastStatus.error) {
    throw new Error(`Failed to pull model: ${lastStatus.error}`);
  }
  return true;
}

/**
 * Get recommended model for Russian
 */
function getRecommendedModel() {
  return RECOMMENDED_MODELS[0]; // qwen2.5:7b
}

/**
 * Full setup check
 */
async function setupCheck(onProgress = () => {}) {
  const result = {
    os: getOsType(),
    ollamaInstalled: false,
    ollamaRunning: false,
    installedModels: [],
    recommendedModel: getRecommendedModel()
  };
  
  onProgress('Проверка Ollama...');
  result.ollamaInstalled = isOllamaInstalled();
  
  if (!result.ollamaInstalled) {
    onProgress('Ollama не установлен. Установка...');
    await installOllama(onProgress);
    result.ollamaInstalled = true;
  }
  
  onProgress('Проверка сервера Ollama...');
  result.ollamaRunning = await isOllamaRunning();
  
  if (!result.ollamaRunning) {
    onProgress('Запуск сервера Ollama...');
    try {
      await startOllamaServer();
      result.ollamaRunning = true;
    } catch (e) {
      onProgress('Не удалось запустить Ollama автоматически. Запустите вручную: ollama serve');
    }
  }
  
  onProgress('Проверка моделей...');
  result.installedModels = await getInstalledModels();
  
  return result;
}

/**
 * Stop all loaded models to free memory
 */
async function stopModels() {
  try {
    if (!await isOllamaRunning()) return;
    // Get running models via /api/ps
    const response = await fetch(`${getOllamaUrl()}/api/ps`);
    const data = await response.json();
    if (data.models && data.models.length > 0) {
      for (const model of data.models) {
        try {
          // Unload each model by sending an empty load request.
          // Always include a small num_ctx: without it, Ollama loads the model at its own
          // built-in default context window (which can be enormous for some vision models,
          // e.g. 262144 for qwen3-vl) just to immediately discard it — a multi-GB memory spike
          // for something meant to free memory.
          await fetch(`${getOllamaUrl()}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model.name, keep_alive: 0, options: { num_ctx: 2048 } })
          });
        } catch (e) {}
      }
    }
  } catch (e) {
    // Ollama not running or API not available
  }
}

module.exports = {
  RECOMMENDED_MODELS,
  DEFAULT_MODEL,
  getOsType,
  findOllamaBinary,
  isOllamaInstalled,
  isOllamaRunning,
  startOllamaServer,
  installOllama,
  getInstalledModels,
  isModelInstalled,
  pullModel,
  getRecommendedModel,
  setupCheck,
  stopModels,
  // getOllamaUrl/setOllamaUrl were defined above but never exported, since this module's own
  // internal functions call them as plain in-scope function references and never needed
  // `module.exports.getOllamaUrl`/`this.getOllamaUrl`. Every external consumer, though —
  // electron/main.js (`ollamaSetup.setOllamaUrl(url)`), scripts/ocr-ai.js and
  // scripts/translate.js (`const { getOllamaUrl } = require('./ollama-setup')`) — got
  // `undefined` back and either threw or silently produced an empty model list. This is why
  // the configured Ollama URL (local OR remote) never actually reached any real OCR/translate
  // request: getInstalledModels() in ocr-ai.js/translate.js called the undefined getOllamaUrl(),
  // threw, and its try/catch quietly returned [] — surfacing as "Model X is not installed.
  // Available: " with an empty list, exactly matching the reported symptom.
  getOllamaUrl,
  setOllamaUrl,
  normalizeOllamaUrl
};
