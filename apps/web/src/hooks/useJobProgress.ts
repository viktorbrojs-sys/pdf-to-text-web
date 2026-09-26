import { useEffect, useState, useCallback } from 'react';

export interface Progress {
  jobId: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  progress: number;
  message?: string;
  error?: string;
  exports?: unknown[];
}

export function useJobProgress(jobId: string | null) {
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    if (!jobId) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/jobs/${jobId}`);

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as Progress;
        setProgress(data);
        // Закрываем WS когда задача завершена
        if (data.status === 'DONE' || data.status === 'FAILED') {
          ws.close();
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => setProgress(prev => prev
      ? { ...prev, status: 'FAILED', error: 'Connection error' }
      : null,
    );

    return () => ws.close();
  }, [jobId]);

  const reset = useCallback(() => setProgress(null), []);

  return { progress, reset };
}
