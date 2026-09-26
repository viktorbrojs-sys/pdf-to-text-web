import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { documentsApi, jobsApi, exportApi, Document, Export } from '../api/client';
import { useJobProgress } from '../hooks/useJobProgress';
import { JobProgressBar } from '../components/JobProgressBar';

export default function DocumentPage() {
  const { id }     = useParams<{ id: string }>();
  const navigate   = useNavigate();

  const [doc, setDoc]           = useState<Document | null>(null);
  const [exports, setExports]   = useState<Export[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError]       = useState('');

  const { progress, reset } = useJobProgress(activeJobId);

  // OCR settings
  const [ocrMethod, setOcrMethod]   = useState<'textpdf' | 'tesseract' | 'ai' | 'unlimited'>('textpdf');
  const [ocrModel, setOcrModel]     = useState('');

  // Translate settings
  const [provider, setProvider]     = useState<'ollama' | 'openai' | 'deepl' | 'deepseek'>('ollama');
  const [targetLang, setTargetLang] = useState('ru');

  // Export
  const [formats, setFormats] = useState({ md: true, docx: true, pdf: false });

  const load = () => {
    if (!id) return;
    documentsApi.get(id).then(setDoc).catch(e => setError(e.message));
    exportApi.list(id).then(setExports).catch(() => {});
  };

  useEffect(() => { load(); }, [id]);

  // Когда задача завершается — перезагружаем документ
  useEffect(() => {
    if (progress?.status === 'DONE') {
      setActiveJobId(null);
      reset();
      load();
    }
  }, [progress?.status]);

  const busy = !!activeJobId && progress?.status === 'RUNNING';

  const startOcr = async () => {
    if (!id) return;
    setError('');
    try {
      const { jobId } = await jobsApi.startOcr(id, { method: ocrMethod, model: ocrModel });
      setActiveJobId(jobId);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Ошибка OCR'); }
  };

  const startTranslate = async () => {
    if (!id) return;
    setError('');
    try {
      const { jobId } = await jobsApi.startTranslate(id, { provider, targetLang });
      setActiveJobId(jobId);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Ошибка перевода'); }
  };

  const startExport = async () => {
    if (!id) return;
    const fmts = (Object.entries(formats).filter(([, v]) => v).map(([k]) => k)) as ('md' | 'docx' | 'pdf')[];
    if (!fmts.length) return;
    setError('');
    try {
      const { jobId } = await exportApi.start(id, fmts);
      setActiveJobId(jobId);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Ошибка экспорта'); }
  };

  if (!doc) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>{error || 'Загрузка...'}</div>;

  const hasText = !!(doc.ocrText);
  const hasTranslation = !!(doc.translated);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13 }}>
          ← Назад
        </button>
        <h2 style={{ margin: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.fileName}
        </h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
          {doc.status}
        </span>
      </div>

      {error && <div className="error-message">✗ {error}</div>}

      {/* Progress */}
      {activeJobId && <JobProgressBar progress={progress} />}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>

        {/* ① OCR */}
        <div className="section" style={{ padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--accent)' }}>① OCR</h3>
          <div className="setting-row" style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Метод</label>
            <select value={ocrMethod} onChange={e => setOcrMethod(e.target.value as typeof ocrMethod)}>
              <option value="textpdf">TextPDF</option>
              <option value="tesseract">Tesseract</option>
              <option value="ai">AI Vision</option>
              <option value="unlimited">UnlimOCR</option>
            </select>
          </div>
          {(ocrMethod === 'ai' || ocrMethod === 'unlimited') && (
            <div className="setting-row" style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Модель</label>
              <input
                value={ocrModel}
                onChange={e => setOcrModel(e.target.value)}
                placeholder="llava:latest"
                style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', color: 'var(--text-primary)', fontSize: 12 }}
              />
            </div>
          )}
          <button className="export-btn-save" onClick={startOcr} disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Обработка...' : 'Запустить OCR'}
          </button>
          {hasText && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--success)' }}>
              ✓ OCR готов ({doc.ocrText!.length.toLocaleString()} символов)
            </div>
          )}
        </div>

        {/* ② Перевод */}
        <div className="section" style={{ padding: 14, opacity: hasText ? 1 : 0.5 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--accent)' }}>② Перевод</h3>
          <div className="setting-row" style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Провайдер</label>
            <select value={provider} onChange={e => setProvider(e.target.value as typeof provider)} disabled={!hasText}>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI</option>
              <option value="deepl">DeepL</option>
              <option value="deepseek">DeepSeek</option>
            </select>
          </div>
          <div className="setting-row" style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Язык</label>
            <select value={targetLang} onChange={e => setTargetLang(e.target.value)} disabled={!hasText}>
              <option value="ru">Русский</option>
              <option value="en">English</option>
              <option value="de">Deutsch</option>
              <option value="fr">Français</option>
            </select>
          </div>
          <button className="export-btn-save" onClick={startTranslate} disabled={busy || !hasText} style={{ width: '100%' }}>
            {busy ? 'Обработка...' : 'Перевести'}
          </button>
          {hasTranslation && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--success)' }}>
              ✓ Перевод готов ({doc.translated!.length.toLocaleString()} символов)
            </div>
          )}
        </div>

        {/* ③ Экспорт */}
        <div className="section" style={{ padding: 14, opacity: hasText ? 1 : 0.5 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--accent)' }}>③ Экспорт</h3>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['md', 'docx', 'pdf'] as const).map(f => (
              <button
                key={f}
                className={`export-fmt-chip ${formats[f] ? 'active' : ''}`}
                onClick={() => setFormats(prev => ({ ...prev, [f]: !prev[f] }))}
                disabled={!hasText}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            className="export-btn-save"
            onClick={startExport}
            disabled={busy || !hasText || !Object.values(formats).some(Boolean)}
            style={{ width: '100%' }}
          >
            {busy ? 'Экспорт...' : 'Сохранить'}
          </button>

          {exports.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Последние файлы:</div>
              {exports.slice(0, 6).map(exp => (
                <a
                  key={exp.id}
                  href={exportApi.downloadUrl(exp.id)}
                  className="export-result"
                  style={{ textDecoration: 'none' }}
                >
                  <span className="format">{exp.format.toUpperCase()} · {doc.fileName.replace('.pdf', '')}.{exp.format}</span>
                  <button className="open-btn">Скачать</button>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Text preview */}
      {(hasTranslation || hasText) && (
        <div className="section" style={{ padding: 14 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {hasTranslation ? 'Перевод' : 'OCR результат'}
            </span>
          </div>
          <textarea
            readOnly
            value={hasTranslation ? doc.translated! : doc.ocrText!}
            className="edit-textarea"
            style={{ minHeight: 240, resize: 'vertical' }}
          />
        </div>
      )}
    </div>
  );
}
