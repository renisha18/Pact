import { Routes, Route } from 'react-router';
import { AuthProvider } from './lib/auth.jsx';
import Navbar from './components/Navbar.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Groups from './pages/Groups.jsx';
import NewGroup from './pages/NewGroup.jsx';
import Group from './pages/Group.jsx';
import Join from './pages/Join.jsx';
import Trip from './pages/Trip.jsx';
import NotFound from './pages/NotFound.jsx';

const authed = (el) => <RequireAuth>{el}</RequireAuth>;

export default function App() {
  return (
    <AuthProvider>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/groups" element={authed(<Groups />)} />
        <Route path="/groups/new" element={authed(<NewGroup />)} />
        <Route path="/groups/:id" element={authed(<Group />)} />
        <Route path="/join/:token" element={authed(<Join />)} />
        <Route path="/trips/:id" element={authed(<Trip />)} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
