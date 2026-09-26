import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { AuthGuard } from './components/AuthGuard';
import DocumentListPage from './pages/DocumentListPage';
import DocumentPage     from './pages/DocumentPage';
import AdminPage        from './pages/AdminPage';

function NavBar() {
  const { user, logout } = useAuth();
  return (
    <nav style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '8px 24px',
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border)',
      fontSize: 13,
    }}>
      <Link to="/" style={{ color: 'var(--accent)', fontWeight: 700, textDecoration: 'none', fontSize: 15 }}>
        📄 PDF to Text
      </Link>
      <span style={{ flex: 1 }} />
      {user?.role === 'ADMIN' && (
        <Link to="/admin" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>
          Админ-панель
        </Link>
      )}
      {user && (
        <>
          <span style={{ color: 'var(--text-muted)' }}>
            {user.username}
            {user.department && <> · {user.department}</>}
            {' '}
            <span style={{ fontSize: 11, opacity: 0.7 }}>({user.role})</span>
          </span>
          <button
            onClick={logout}
            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-secondary)', padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}
          >
            Выйти
          </button>
        </>
      )}
    </nav>
  );
}

function AppRoutes() {
  return (
    <>
      <NavBar />
      <main style={{ minHeight: 'calc(100vh - 45px)' }}>
        <Routes>
          <Route path="/" element={
            <AuthGuard>
              <DocumentListPage />
            </AuthGuard>
          } />
          <Route path="/documents/:id" element={
            <AuthGuard>
              <DocumentPage />
            </AuthGuard>
          } />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
