import { Routes, Route, Navigate } from 'react-router';
import { AuthProvider } from './lib/auth.jsx';
import { ToastProvider } from './lib/toast.jsx';
import { useLocation } from 'react-router';
import Navbar from './components/Navbar.jsx';
import AppNavbar from './components/AppNavbar.jsx';
import Profile from './pages/Profile.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Groups from './pages/Groups.jsx';
import Group from './pages/Group.jsx';
import GroupSettings from './pages/GroupSettings.jsx';
import Join from './pages/Join.jsx';
import Trip from './pages/Trip.jsx';
import NotFound from './pages/NotFound.jsx';

const APP_PREFIXES = ['/dashboard', '/profile', '/groups', '/trips', '/join'];

function Chrome() {
  const { pathname } = useLocation();
  return APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? <AppNavbar /> : <Navbar />;
}

const authed = (el) => <RequireAuth>{el}</RequireAuth>;

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
      <Chrome />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={authed(<Groups />)} />
        <Route path="/profile" element={authed(<Profile />)} />
        <Route path="/groups" element={<Navigate to="/dashboard" replace />} />
        <Route path="/groups/new" element={authed(<Groups />)} />
        <Route path="/groups/:id/settings" element={authed(<GroupSettings />)} />
        <Route path="/groups/:id" element={authed(<Group />)} />
        <Route path="/join/:token" element={authed(<Join />)} />
        <Route path="/trips/:id" element={authed(<Trip />)} />
        <Route path="/trips/:id/:tab" element={authed(<Trip />)} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
