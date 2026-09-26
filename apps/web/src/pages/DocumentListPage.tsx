import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { documentsApi, Document } from '../api/client';

const STATUS_LABEL: Record<string, string> = {
  UPLOADED:          '📄 Загружен',
  OCR_PENDING:       '⏳ OCR...',
  OCR_DONE:          '✅ OCR готов',
  TRANSLATE_PENDING: '⏳ Перевод...',
  TRANSLATE_DONE:    '✅ Переведён',
  EXPORT_READY:      '💾 Готов к скачиванию',
  ERROR:             '❌ Ошибка',
};

export default function DocumentListPage() {
  const [docs, setDocs]       = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError]     = useState('');
  const fileRef               = useRef<HTMLInputElement>(null);
  const navigate              = useNavigate();

  const load = () =>
    documentsApi.list()
      .then(setDocs)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const doc = await documentsApi.upload(file);
      navigate(`/documents/${doc.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить документ?')) return;
    await documentsApi.delete(id);
    setDocs(prev => prev.filter(d => d.id !== id));
  };

  return (
    <div className="section" style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Мои документы</h2>
        <button
          className="export-btn-save"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? '⏳ Загрузка...' : '+ Загрузить PDF'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          style={{ display: 'none' }}
          onChange={handleUpload}
        />
      </div>

      {error && <div className="error-message" style={{ marginBottom: 12 }}>✗ {error}</div>}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Загрузка...</p>
      ) : docs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <p>Нет загруженных документов</p>
          <p style={{ fontSize: 13 }}>Нажмите «Загрузить PDF» чтобы начать</p>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Файл</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Статус</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Дата</th>
              <th style={{ padding: '6px 8px' }} />
            </tr>
          </thead>
          <tbody>
            {docs.map(doc => (
              <tr
                key={doc.id}
                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                onClick={() => navigate(`/documents/${doc.id}`)}
              >
                <td style={{ padding: '8px 8px', color: 'var(--text-primary)', fontWeight: 500 }}>
                  {doc.fileName}
                </td>
                <td style={{ padding: '8px 8px', color: 'var(--text-secondary)' }}>
                  {STATUS_LABEL[doc.status] ?? doc.status}
                </td>
                <td style={{ padding: '8px 8px', color: 'var(--text-muted)' }}>
                  {new Date(doc.createdAt).toLocaleDateString('ru-RU')}
                </td>
                <td style={{ padding: '8px 8px', textAlign: 'right' }}>
                  <button
                    className="export-result open-btn"
                    onClick={e => { e.stopPropagation(); handleDelete(doc.id); }}
                    style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
