import { Link } from 'react-router';

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center">
      <h1 className="text-2xl font-bold">Nothing here yet</h1>
      <p className="mt-3 text-pine-soft">This page is still being pitched.</p>
      <Link to="/" className="mt-6 rounded-full bg-coral px-6 py-3 font-medium text-cloud hover:bg-coral-dark">
        Back home
      </Link>
    </main>
  );
}
