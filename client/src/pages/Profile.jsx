import { Link } from 'react-router';
import { useAuth } from '../lib/auth.jsx';
import { Page, Avatar, card } from '../components/ui.jsx';

export default function Profile() {
  const { user } = useAuth();
  return (
    <Page narrow>
      <Link to="/dashboard" className="text-sm text-pine-soft hover:text-pine">← Back to dashboard</Link>
      <div className={`${card} mt-4 flex flex-col items-center text-center`}>
        <Avatar emoji={user.avatarEmoji} size="h-20 w-20 text-5xl" />
        <h1 className="mt-4 text-2xl font-bold">{user.name}</h1>
        <p className="mt-1 text-sm text-pine-soft">{user.email}</p>
      </div>
    </Page>
  );
}
