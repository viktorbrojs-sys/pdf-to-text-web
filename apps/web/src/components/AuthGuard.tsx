import { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';

export function AuthGuard({ children, role }: { children: ReactNode; role?: 'MANAGER' | 'ADMIN' }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Загрузка...</p>
      </div>
    );
  }

  if (!user) {
    window.location.href = '/auth/login';
    return null;
  }

  if (role) {
    const order = ['USER', 'MANAGER', 'ADMIN'];
    if (order.indexOf(user.role) < order.indexOf(role)) {
      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2 style={{ color: 'var(--error)' }}>Доступ запрещён</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Недостаточно прав для просмотра этой страницы.</p>
        </div>
      );
    }
  }

  return <>{children}</>;
}
