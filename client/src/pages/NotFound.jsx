import { Link } from 'react-router';
import { useAuth } from '../lib/auth.jsx';
import PixelCamp from '../components/PixelCamp.jsx';

export default function NotFound() {
  const { user } = useAuth();
  return (
    <main className="mx-auto flex max-w-xl flex-col items-center px-4 py-16 text-center sm:py-24">
      <PixelCamp className="h-28 w-72 overflow-hidden rounded-2xl" />
      <h1 className="mt-6 text-2xl font-bold">This page wandered off</h1>
      <p className="mt-3 text-pine-soft">We couldn’t find what you were looking for.</p>
      <Link to={user ? '/dashboard' : '/'} className="mt-6 rounded-full bg-coral px-6 py-3 font-medium text-cloud hover:bg-coral-dark">
        {user ? 'Back to dashboard' : 'Back home'}
      </Link>
    </main>
  );
}
