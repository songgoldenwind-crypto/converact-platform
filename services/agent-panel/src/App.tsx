import { Navigate, Route, Routes } from 'react-router-dom';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import CallRoomPage from './pages/CallRoom';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('opc_token');
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/call"
        element={
          <RequireAuth>
            <CallRoomPage />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
