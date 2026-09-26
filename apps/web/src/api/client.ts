// Центральный API-клиент — заменяет window.electronAPI из desktop-версии.
// Все методы возвращают Promise, прогресс идёт через useJobProgress hook (WebSocket).

export interface User {
  id: string;
  keycloakId: string;
  username: string;
  email: string;
  department?: string;
  role: 'USER' | 'MANAGER' | 'ADMIN';
  createdAt: string;
}

export interface Document {
  id: string;
  userId: string;
  fileName: string;
  storagePath: string;
  status: string;
  ocrMethod?: string;
  ocrText?: string;
  translated?: string;
  language?: string;
  jobs: Job[];
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  documentId: string;
  type: 'OCR' | 'TRANSLATE' | 'EXPORT';
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  progress: number;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface Export {
  id: string;
  documentId: string;
  format: string;
  storagePath: string;
  sizeBytes?: number;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (res.status === 401) {
    window.location.href = '/auth/login';
    return Promise.reject(new Error('Unauthorized'));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────

export const authApi = {
  me: ()      => request<User>('/auth/me'),
  logout: () => request<{ logoutUrl: string }>('/auth/logout', { method: 'POST' }),
};

// ── Documents ─────────────────────────────────────────────────────────────

export const documentsApi = {
  list: () => request<Document[]>('/api/documents'),

  get: (id: string) => request<Document>(`/api/documents/${id}`),

  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Document>('/api/documents/upload', {
      method: 'POST',
      body: form,
      headers: {}, // убираем Content-Type — браузер сам выставит multipart boundary
    });
  },

  delete: (id: string) => request<void>(`/api/documents/${id}`, { method: 'DELETE' }),
};

// ── Jobs ──────────────────────────────────────────────────────────────────

export const jobsApi = {
  startOcr: (docId: string, options: {
    method: 'textpdf' | 'tesseract' | 'ai' | 'unlimited';
    model?: string;
    language?: string;
    insertImages?: boolean;
  }) =>
    request<{ jobId: string }>(`/api/documents/${docId}/ocr`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  startTranslate: (docId: string, options: {
    provider: 'ollama' | 'openai' | 'deepl' | 'deepseek';
    model?: string;
    targetLang?: string;
  }) =>
    request<{ jobId: string }>(`/api/documents/${docId}/translate`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  get: (jobId: string) => request<Job>(`/api/jobs/${jobId}`),
};

// ── Export ────────────────────────────────────────────────────────────────

export const exportApi = {
  start: (docId: string, formats: ('md' | 'docx' | 'pdf')[]) =>
    request<{ jobId: string }>(`/api/documents/${docId}/export`, {
      method: 'POST',
      body: JSON.stringify({ formats }),
    }),

  list: (docId: string) => request<Export[]>(`/api/documents/${docId}/exports`),

  downloadUrl: (exportId: string) => `/api/exports/${exportId}/download`,
};

// ── Admin ─────────────────────────────────────────────────────────────────

export const adminApi = {
  users: ()                                    => request<User[]>('/api/admin/users'),
  setRole: (userId: string, role: string)      => request<User>(`/api/admin/users/${userId}/role`, {
    method: 'PATCH', body: JSON.stringify({ role }),
  }),
  logs: (params?: Record<string, string>)      => request<{ total: number; logs: unknown[] }>(
    `/api/admin/logs?${new URLSearchParams(params)}`,
  ),
  jobs: (params?: Record<string, string>)      => request<{ total: number; jobs: unknown[] }>(
    `/api/admin/jobs?${new URLSearchParams(params)}`,
  ),
  retryJob: (jobId: string)                    => request<{ retryJobId: string }>(
    `/api/admin/jobs/${jobId}/retry`, { method: 'POST' },
  ),
  stats: ()                                    => request<Record<string, unknown>>('/api/admin/stats'),
  settings: ()                                 => request<Record<string, string>>('/api/admin/settings'),
  saveSettings: (data: Record<string, string>) => request<{ updated: number }>(
    '/api/admin/settings', { method: 'PATCH', body: JSON.stringify(data) },
  ),
};
