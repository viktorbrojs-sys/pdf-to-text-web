import { Progress } from '../hooks/useJobProgress';

interface Props {
  progress: Progress | null;
}

export function JobProgressBar({ progress }: Props) {
  if (!progress) return null;

  const { status, progress: pct, message, error } = progress;

  const barColor =
    status === 'DONE'   ? 'var(--success)' :
    status === 'FAILED' ? 'var(--error)'   :
    'var(--accent)';

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        height: 4,
        background: 'var(--border)',
        borderRadius: 2,
        overflow: 'hidden',
        marginBottom: 4,
      }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: barColor,
          transition: 'width 0.3s ease',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
        <span style={{ color: status === 'FAILED' ? 'var(--error)' : 'var(--text-secondary)' }}>
          {error ?? message ?? status}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{pct}%</span>
      </div>
    </div>
  );
}
