import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import GroupCards from '../components/GroupCards.jsx';
import NewGroupModal from '../components/NewGroupModal.jsx';

export default function Groups() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const showing = open || pathname === '/groups/new';

  function close(created) {
    setOpen(false);
    if (created) setVersion((v) => v + 1);
    if (pathname === '/groups/new') navigate('/dashboard', { replace: true });
  }

  return (
    <div className="pt-8 sm:pt-12">
      <GroupCards key={version} onCreate={() => setOpen(true)} />
      {showing && <NewGroupModal onClose={close} />}
    </div>
  );
}
