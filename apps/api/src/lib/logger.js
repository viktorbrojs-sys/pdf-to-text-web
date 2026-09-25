const fs = require('fs');
const path = require('path');

let LOGS_DIR = path.join(__dirname, '..', 'logs');
let LOG_FILE = path.join(LOGS_DIR, 'app.log');
const MAX_LOG_LINES = 1000;
const SESSION_START = Date.now();

// Allow overriding log directory (for packaged apps where __dirname is read-only)
function setLogDir(dir) {
  LOGS_DIR = dir;
  LOG_FILE = path.join(dir, 'app.log');
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

// Ensure log directory exists
if (!fs.existsSync(LOGS_DIR)) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch (e) {
    // Fallback: try /tmp
    LOGS_DIR = path.join(require('os').tmpdir(), 'pdf-to-text-logs');
    LOG_FILE = path.join(LOGS_DIR, 'app.log');
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function getTimestamp() {
  return new Date().toISOString();
}

function log(level, message, meta = null) {
  const timestamp = getTimestamp();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${timestamp}] [${level}] ${message}${metaStr}\n`;

  try {
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
    trimLogFile();
  } catch (e) {
    console.error('Logger write failed:', e.message);
  }
}

function trimLogFile() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > MAX_LOG_LINES) {
      const trimmed = lines.slice(-MAX_LOG_LINES).join('\n') + '\n';
      fs.writeFileSync(LOG_FILE, trimmed, 'utf-8');
    }
  } catch (e) {
    console.error('Logger trim failed:', e.message);
  }
}

function getRecentLogs(count = 100) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    return lines.slice(-count);
  } catch (e) {
    console.error('Logger read failed:', e.message);
    return [];
  }
}

function getSessionLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const sessionDate = new Date(SESSION_START).toISOString().slice(0, 19);
    return lines.filter(l => {
      const match = l.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:]+)/);
      return match && match[1] >= sessionDate;
    });
  } catch (e) {
    console.error('Logger session read failed:', e.message);
    return [];
  }
}

function info(message, meta) { log('INFO', message, meta); }
function warn(message, meta) { log('WARN', message, meta); }
function error(message, meta) { log('ERROR', message, meta); }

module.exports = { info, warn, error, getRecentLogs, getSessionLogs, setLogDir };
