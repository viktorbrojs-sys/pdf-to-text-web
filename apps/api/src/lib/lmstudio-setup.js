// LM Studio connection management — deliberately mirrors ollama-setup.js's shape (getUrl/setUrl,
// a single module-level URL, HTTP-based status checks) so the rest of the app (ocr-ai.js,
// translate.js, main.js, and the frontend) can treat it the same way it already treats Ollama.
//
// Unlike Ollama, LM Studio:
// - Has no CLI-installable "ollama serve" equivalent this app can spawn — it's a GUI desktop app
//   the person installs and runs themselves, so there's no auto-install/auto-start here.
// - Exposes an OpenAI-compatible REST API (GET /v1/models, POST /v1/chat/completions) rather than
//   Ollama's own /api/* routes.
// - /v1/models only lists whatever model(s) the person has already loaded in the LM Studio UI —
//   there's no "pull a model" equivalent reachable from this API, so there's no download/progress
//   flow to replicate here.

let _lmStudioUrl = 'http://localhost:1234';

function normalizeLMStudioUrl(url) {
  if (!url || !url.trim()) return _lmStudioUrl;
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

function getLMStudioUrl() {
  return _lmStudioUrl;
}

function setLMStudioUrl(url) {
  _lmStudioUrl = normalizeLMStudioUrl(url);
}

// Returns [{ name }] — shaped like ollama-setup.js's getInstalledModels() so the frontend can
// treat both the same way (e.g. `models.some(m => m.name === selected)`).
async function getLMStudioModels(url) {
  const base = url ? normalizeLMStudioUrl(url) : getLMStudioUrl();
  const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return (data.data || []).map(m => ({ name: m.id }));
}

async function isLMStudioReachable(url) {
  try {
    await getLMStudioModels(url);
    return true;
  } catch (e) {
    return false;
  }
}

// Mirrors the shape of ollama-status/set-ollama-url responses: { installed, running, models }.
// "installed" and "running" collapse to the same thing here (reachable or not) since there's no
// separate "binary present but server not started" state this app can detect over HTTP alone.
async function checkLMStudioStatus(url) {
  try {
    const models = await getLMStudioModels(url);
    return { installed: true, running: true, models };
  } catch (e) {
    return { installed: false, running: false, models: [] };
  }
}

// Returns plain model id strings (not {name} objects) — matches test-ollama-connection's shape,
// which the frontend's connection-test result line already expects (`models.join(', ')`).
async function testLMStudioConnection(url) {
  try {
    const models = await getLMStudioModels(url);
    return { success: true, models: models.map(m => m.name) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  getLMStudioUrl,
  setLMStudioUrl,
  normalizeLMStudioUrl,
  getLMStudioModels,
  isLMStudioReachable,
  checkLMStudioStatus,
  testLMStudioConnection
};
