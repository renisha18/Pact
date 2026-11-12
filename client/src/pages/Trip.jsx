import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/useApi.js';
import { useToast } from '../lib/toast.jsx';
import { formatRange } from '../lib/format.js';
import { ACTION_TAB, COMMIT_STAGE, EDITABLE_TRIP, HAS_PROPOSALS, TABS, activeMembers } from '../lib/tripState.js';
import { Page, ErrorNote, NotFoundCard, Skeleton, TripStatusChip } from '../components/ui.jsx';
import { PlanPanel, Proposals, AskPact, PlanStatus, NegotiationCard } from '../components/Planning.jsx';
import { CommitPanel } from '../components/Commit.jsx';
import DatesCard from '../components/trip/DatesCard.jsx';
import PrivateForm from '../components/trip/PrivateForm.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import TripTabs from '../components/trip/TripTabs.jsx';
import OverviewTab from '../components/trip/OverviewTab.jsx';

const LOCKED_MEMBER = new Set(['committed', 'dropped']);
const POLL = 5000; // database endpoints only; plan/ask (AI) are never polled

function TripSkeleton() {
  return (
    <Page>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-4 h-10 w-2/3" />
      <Skeleton className="mt-8 h-40" />
      <Skeleton className="mt-4 h-40" />
    </Page>
  );
}

export default function Trip() {
  const { id, tab: tabParam } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useApi(`/api/trips/${encodeURIComponent(id)}`, { pollMs: POLL });
  const actionsApi = useApi('/api/me/actions', { pollMs: POLL });
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [planMessage, setPlanMessage] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  const refreshAll = async () => { await reload(); actionsApi.reload(); bump(); };

  const tripId = Number(id);
  const myActions = (actionsApi.data ?? []).filter((a) => a.tripId === tripId);
  const pending = new Set(myActions.map((a) => ACTION_TAB[a.kind]).filter(Boolean));

  // Tabs are path-based: /trips/:id/{overview|plan|commit|ask}.
  // /trips/:id (no tab) opens the tab holding my first pending action; old ?tab= links map to the path form.
  const validTab = (t) => TABS.some((x) => x.id === t);
  const legacyTab = params.get('tab');
  const wantsAuto = !tabParam && !legacyTab;
  const autoTab = myActions[0] ? ACTION_TAB[myActions[0].kind] ?? 'overview' : 'overview';
  const go = (t) => navigate(`/trips/${id}/${t}`);

  if (legacyTab) return <Navigate to={`/trips/${id}/${validTab(legacyTab) ? legacyTab : 'overview'}`} replace />;
  if (tabParam && !validTab(tabParam)) return <Navigate to={`/trips/${id}/overview`} replace />;
  if (wantsAuto && actionsApi.data) return <Navigate to={`/trips/${id}/${autoTab}`} replace />;
  const tab = tabParam ?? null;

  async function plan() {
    setPlanning(true);
    setPlanError(null);
    setPlanMessage(null);
    try {
      const res = await api(`/api/trips/${encodeURIComponent(id)}/plan`, { method: 'POST' });
      // Status notices (working privately / Plan B) have their own cards.
      setPlanMessage(res.proposals?.length === 0 && !res.planB && !res.message?.startsWith('Pact ') ? res.message ?? null : null);
      await refreshAll();
      if (res.proposals?.length) toast('Pact found stays for the group');
    } catch (err) {
      setPlanError(err.message);
    } finally {
      setPlanning(false);
    }
  }

  if (loading && !data) return <TripSkeleton />;
  if (error && !data) {
    return (
      <Page narrow>
        {error.status === 404 ? <NotFoundCard what="trip" /> : <ErrorNote>{error.message}</ErrorNote>}
      </Page>
    );
  }

  const { trip, members, myStatus } = data;
  const isOrganizer = data.myRole === 'organizer';
  const editable = EDITABLE_TRIP.has(trip.status) && !LOCKED_MEMBER.has(myStatus);
  const waitingCount = activeMembers(members).filter((m) => m.status === 'invited').length;
  const showProposals = HAS_PROPOSALS.has(trip.status) && !planning;
  const left = myStatus === 'dropped';

  return (
    <Page>
      <Breadcrumbs items={[
        { label: 'Dashboard', to: '/dashboard' },
        { label: data.groupName, to: `/groups/${trip.groupId}` },
        { label: trip.title, to: `/trips/${trip.id}/overview` },
        ...(tab ? [{ label: TABS.find((t) => t.id === tab).label }] : []),
      ]} />
      <Link to={`/groups/${trip.groupId}`} className="text-sm text-pine-soft hover:text-pine">← {data.groupName}</Link>
      <header className="mt-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold sm:text-3xl">{trip.title}</h1>
          <TripStatusChip status={trip.status} />
        </div>
        <p className="mt-2 text-pine-soft">
          {trip.region} · {trip.startDate ? formatRange(trip.startDate, trip.endDate) : 'Dates: deciding…'} · {trip.nights} {trip.nights === 1 ? 'night' : 'nights'}
        </p>
      </header>

      <TripTabs active={tab} onChange={go} pending={pending} />

      <div id="trip-panel" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="mt-6 space-y-6 pb-24 md:pb-8">
        <ErrorBoundary resetKey={tab}>
        {!tab && <Skeleton className="h-40" />}

        {tab === 'overview' && (
          <OverviewTab trip={trip} members={members} myStatus={myStatus} isOrganizer={isOrganizer} meId={user.id}
            myActions={myActions} onGo={go} />
        )}

        {tab === 'plan' && (
          <>
            <DatesCard tripId={trip.id} isOrganizer={isOrganizer} editable={editable && !left} refreshKey={refreshKey}
              onChanged={refreshAll} />
            <PrivateForm tripId={trip.id} editable={editable}
              onSaved={async () => { toast('Details saved privately'); await refreshAll(); }} />
            {!left && (
              <NegotiationCard tripId={trip.id} refreshKey={refreshKey}
                onResolved={async (msg) => { toast(msg || 'Response sent'); await refreshAll(); }} />
            )}
            {(EDITABLE_TRIP.has(trip.status) || planning) && (
              <PlanPanel isOrganizer={isOrganizer} waitingCount={waitingCount} planning={planning}
                error={planError} message={planMessage} onPlan={plan} />
            )}
            {(EDITABLE_TRIP.has(trip.status) || trip.status === 'voting') && !planning && (
              <PlanStatus tripId={trip.id} tripNights={trip.nights} refreshKey={refreshKey} />
            )}
            {showProposals && (
              <>
                {planError && <p role="alert" className="rounded-xl bg-coral/10 px-3 py-2 text-sm text-coral-dark">{planError}</p>}
                <Proposals tripId={trip.id} tripStatus={trip.status} canVote={!left} isOrganizer={isOrganizer}
                  onChanged={async () => { toast('Voting complete'); await refreshAll(); }} onReplan={plan}
                  hideShare={COMMIT_STAGE.has(trip.status)} />
              </>
            )}
          </>
        )}

        {tab === 'commit' && (
          COMMIT_STAGE.has(trip.status) && !left ? (
            <CommitPanel trip={trip} isOrganizer={isOrganizer}
              onTripChanged={refreshAll} onNotice={(m) => toast(m || 'Done')} />
          ) : (
            <p className="rounded-2xl bg-cloud p-5 text-sm text-pine-soft ring-1 ring-mint-dark">
              {left ? 'You’ve left this trip.' : trip.status === 'cancelled' ? 'This trip was cancelled.'
                : 'Commitments open once the group has decided on a stay.'}
            </p>
          )
        )}

        {tab === 'ask' && <AskPact tripId={trip.id} />}
        </ErrorBoundary>
      </div>
    </Page>
  );
}
