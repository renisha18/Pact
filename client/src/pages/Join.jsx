import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api.js';
import { useApi } from '../lib/useApi.js';
import { Page, Loading, ErrorNote, NotFoundCard, btn, card } from '../components/ui.jsx';

export default function Join() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { data: invite, error, loading } = useApi(`/api/invites/${encodeURIComponent(token)}`);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);

  async function join() {
    setJoining(true);
    setJoinError(null);
    try {
      const { groupId } = await api(`/api/invites/${encodeURIComponent(token)}/join`, { method: 'POST' });
      navigate(`/groups/${groupId}`, { replace: true });
    } catch (err) {
      setJoinError(err.message);
      setJoining(false);
    }
  }

  return (
    <Page narrow>
      {loading && <Loading />}
      {error && <NotFoundCard what="invite" />}
      {invite && (
        <div className={`${card} text-center`}>
          <div className="text-5xl" aria-hidden="true">{invite.emoji}</div>
          <h1 className="mt-4 text-2xl font-bold text-balance">
            You’re invited to {invite.groupName}
          </h1>
          <p className="mt-2 text-pine-soft">
            {invite.memberCount} {invite.memberCount === 1 ? 'member' : 'members'} so far
          </p>
          <div className="mt-6 space-y-3">
            <ErrorNote>{joinError}</ErrorNote>
            <button type="button" onClick={join} disabled={joining} className={`${btn.base} ${btn.coral} w-full sm:w-auto`}>
              {joining ? 'Joining…' : 'Join the group'}
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}
