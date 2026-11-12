import { Link } from 'react-router';
import { useAuth } from '../lib/auth.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import { Page, Avatar, card } from '../components/ui.jsx';

export default function Profile() {
  const { user } = useAuth();
  return (
    <Page narrow>
      <Breadcrumbs items={[{ label: 'Dashboard', to: '/dashboard' }, { label: 'Profile' }]} />
      <Link to="/dashboard" className="text-sm text-pine-soft hover:text-pine">← Dashboard</Link>
      <div className={`${card} mt-4 flex flex-col items-center text-center`}>
        <Avatar emoji={user.avatarEmoji} size="h-20 w-20 text-5xl" />
        <h1 className="mt-4 text-2xl font-bold">{user.name}</h1>
        <p className="mt-1 text-sm text-pine-soft">{user.email}</p>
      </div>
    </Page>
  );
}
