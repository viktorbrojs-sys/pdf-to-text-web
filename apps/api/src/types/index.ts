export type Role = 'USER' | 'MANAGER' | 'ADMIN';

export interface JwtPayload {
  sub: string;          // keycloakId
  email: string;
  username: string;
  department?: string;
  role: Role;
  iat?: number;
  exp?: number;
}

export interface Progress {
  jobId: string;
  type: 'OCR' | 'TRANSLATE' | 'EXPORT';
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  progress: number;     // 0–100
  message?: string;
  error?: string;
}

export interface OcrOptions {
  method: 'textpdf' | 'tesseract' | 'ai' | 'unlimited';
  model?: string;
  language?: string;
  insertImages?: boolean;
}

export interface TranslateOptions {
  provider: 'ollama' | 'openai' | 'deepl' | 'deepseek';
  model?: string;
  targetLang?: string;
  glossaryPath?: string;
}
