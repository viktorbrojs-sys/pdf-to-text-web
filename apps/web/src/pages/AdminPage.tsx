import { useEffect, useState } from 'react';
import { adminApi } from '../api/client';
import { AuthGuard } from '../components/AuthGuard';

type Tab = 'stats' | 'users' | 'logs' | 'jobs' | 'settings';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('stats');

  return (
    <AuthGuard role="ADMIN">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
        <h2 style={{ marginBottom: 16 }}>Панель администратора</h2>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
          {(['stats', 'users', 'logs', 'jobs', 'settings'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '5px 16px',
                background: tab === t ? 'var(--accent-dim)' : 'transparent',
                border: '1px solid ' + (tab === t ? 'var(--accent)' : 'var(--border)'),
                borderRadius: 6,
                color: tab === t ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 13,
                textTransform: 'capitalize',
              }}
            >
              {{ stats: 'Статистика', users: 'Пользователи', logs: 'Аудит', jobs: 'Задачи', settings: 'Настройки' }[t]}
            </button>
          ))}
        </div>

        {tab === 'stats'    && <StatsTab />}
        {tab === 'users'    && <UsersTab />}
        {tab === 'logs'     && <LogsTab />}
        {tab === 'jobs'     && <JobsTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </AuthGuard>
  );
}

// ── Stats ─────────────────────────────────────────────────────────────────

function StatsTab() {
  const [stats, setStats] = useState<Record<string, any> | null>(null);
  useEffect(() => { adminApi.stats().then(setStats); }, []);
  if (!stats) return <p style={{ color: 'var(--text-muted)' }}>Загрузка...</p>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
      {[
        { label: 'Пользователей', value: stats.users?.total },
        { label: 'Документов',    value: stats.documents?.total },
        { label: 'Задач всего',   value: stats.jobs?.total },
        { label: 'Ошибок',        value: stats.jobs?.failed, warn: true },
      ].map(({ label, value, warn }) => (
        <div key={label} className="section" style={{ padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: warn && value ? 'var(--error)' : 'var(--accent)' }}>
            {value ?? '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// ── Users ─────────────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);
  useEffect(() => { adminApi.users().then(setUsers); }, []);

  const changeRole = async (userId: string, role: string) => {
    await adminApi.setRole(userId, role);
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, role } : u));
  };

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          {['Пользователь', 'Email', 'Отдел', 'Роль', 'Документов'].map(h => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {users.map(u => (
          <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: '8px 8px', color: 'var(--text-primary)', fontWeight: 500 }}>{u.username}</td>
            <td style={{ padding: '8px 8px', color: 'var(--text-secondary)' }}>{u.email}</td>
            <td style={{ padding: '8px 8px', color: 'var(--text-muted)' }}>{u.department ?? '—'}</td>
            <td style={{ padding: '8px 8px' }}>
              <select
                value={u.role}
                onChange={e => changeRole(u.id, e.target.value)}
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 12, padding: '2px 4px' }}
              >
                <option>USER</option>
                <option>MANAGER</option>
                <option>ADMIN</option>
              </select>
            </td>
            <td style={{ padding: '8px 8px', color: 'var(--text-muted)', textAlign: 'right' }}>{u._count?.documents ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Audit log ─────────────────────────────────────────────────────────────

function LogsTab() {
  const [data, setData] = useState<{ total: number; logs: any[] } | null>(null);
  const [action, setAction] = useState('');

  const load = () => adminApi.logs(action ? { action } : undefined).then(setData);
  useEffect(() => { load(); }, [action]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <select value={action} onChange={e => setAction(e.target.value)}
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 12, padding: '4px 8px' }}>
          <option value="">Все действия</option>
          {['LOGIN','LOGOUT','UPLOAD','OCR_START','OCR_DONE','TRANSLATE_START','TRANSLATE_DONE','EXPORT_DOWNLOAD','ROLE_CHANGE','SETTINGS_CHANGE','DOCUMENT_DELETE'].map(a => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
          Записей: {data?.total ?? '...'}
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            {['Время', 'Действие', 'Пользователь', 'IP', 'Детали'].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '5px 8px' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(data?.logs ?? []).map((log: any) => (
            <tr key={log.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {new Date(log.createdAt).toLocaleString('ru-RU')}
              </td>
              <td style={{ padding: '6px 8px', color: 'var(--accent)', fontWeight: 500 }}>{log.action}</td>
              <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{log.user?.username ?? '—'}</td>
              <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{log.ip ?? '—'}</td>
              <td style={{ padding: '6px 8px', color: 'var(--text-muted)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {log.meta ? JSON.stringify(log.meta) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Jobs ──────────────────────────────────────────────────────────────────

function JobsTab() {
  const [data, setData] = useState<{ total: number; jobs: any[] } | null>(null);
  const [status, setStatus] = useState('FAILED');

  const load = () => adminApi.jobs({ status }).then(setData);
  useEffect(() => { load(); }, [status]);

  const retry = async (jobId: string) => {
    await adminApi.retryJob(jobId);
    load();
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {['FAILED', 'RUNNING', 'DONE', ''].map(s => (
          <button key={s}
            onClick={() => setStatus(s)}
            style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
              background: status === s ? 'var(--accent-dim)' : 'transparent',
              border: '1px solid ' + (status === s ? 'var(--accent)' : 'var(--border)'),
              color: status === s ? 'var(--accent)' : 'var(--text-secondary)',
            }}>
            {s || 'Все'}
          </button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
          Записей: {data?.total ?? '...'}
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            {['Тип', 'Статус', 'Документ', 'Пользователь', 'Создан', 'Ошибка', ''].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '5px 8px' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(data?.jobs ?? []).map((job: any) => (
            <tr key={job.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '6px 8px', color: 'var(--text-primary)' }}>{job.type}</td>
              <td style={{ padding: '6px 8px', color: job.status === 'FAILED' ? 'var(--error)' : job.status === 'DONE' ? 'var(--success)' : 'var(--warning)' }}>
                {job.status}
              </td>
              <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.document?.fileName}
              </td>
              <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{job.document?.user?.username}</td>
              <td style={{ padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {new Date(job.createdAt).toLocaleString('ru-RU')}
              </td>
              <td style={{ padding: '6px 8px', color: 'var(--error)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.error}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {job.status === 'FAILED' && (
                  <button className="export-result open-btn" onClick={() => retry(job.id)}>Retry</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => { adminApi.settings().then(setSettings); }, []);

  const defaults: Record<string, { label: string; placeholder: string }> = {
    max_upload_mb:      { label: 'Макс. размер файла (МБ)', placeholder: '50' },
    ollama_url:         { label: 'Ollama URL', placeholder: 'http://ollama:11434' },
    allowed_ocr_methods:{ label: 'Разрешённые методы OCR', placeholder: 'textpdf,tesseract,ai,unlimited' },
    default_language:   { label: 'Язык OCR по умолчанию', placeholder: 'rus' },
  };

  const save = async () => {
    await adminApi.saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ maxWidth: 540 }}>
      {Object.entries(defaults).map(([key, { label, placeholder }]) => (
        <div key={key} style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</label>
          <input
            value={settings[key] ?? ''}
            onChange={e => setSettings(prev => ({ ...prev, [key]: e.target.value }))}
            placeholder={placeholder}
            style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)', fontSize: 13 }}
          />
        </div>
      ))}
      <button className="export-btn-save" onClick={save}>
        {saved ? '✓ Сохранено' : 'Сохранить настройки'}
      </button>
    </div>
  );
}
