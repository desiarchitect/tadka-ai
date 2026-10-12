import React from 'react';

import type { DemoUser } from '../demo.js';

type UserOption = DemoUser | 'none';

interface AuthStatusProps {
  demoLogin: boolean;
  currentUser: UserOption;
  userEmail: string | null;
  onSelectUser: (user: UserOption) => void;
  isLoading: boolean;
}

export const AuthStatus: React.FC<AuthStatusProps> = ({
  demoLogin,
  currentUser,
  userEmail,
  onSelectUser,
  isLoading,
}) => {
  if (!demoLogin) {
    return (
      <section className="auth-bar" aria-label="Authentication Controls">
        <div className="auth-info">
          <span className="auth-badge unauthenticated" role="status">
            &#9675; Not signed in. The demo sign-in is switched off in this build.
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-bar" aria-label="Authentication Controls">
      <div className="auth-info">
        <span className="diag-label">Active Caller:</span>
        {currentUser !== 'none' ? (
          <span className="auth-badge authenticated">
            &#9679; {currentUser === 'rahul' ? 'Rahul (Customer)' : 'Aman (Customer)'}
            {userEmail ? ` (${userEmail})` : ''}
          </span>
        ) : (
          <span className="auth-badge unauthenticated">
            &#9675; Unauthenticated (Demonstrates 401 Rejection)
          </span>
        )}
      </div>

      <div className="auth-actions">
        <span className="diag-label">Simulate Identity:</span>
        <button
          type="button"
          className={`btn-sm ${currentUser === 'rahul' ? 'active' : ''}`}
          onClick={() => onSelectUser('rahul')}
          disabled={isLoading}
          aria-pressed={currentUser === 'rahul'}
        >
          Sign in as Rahul
        </button>
        <button
          type="button"
          className={`btn-sm ${currentUser === 'aman' ? 'active' : ''}`}
          onClick={() => onSelectUser('aman')}
          disabled={isLoading}
          aria-pressed={currentUser === 'aman'}
        >
          Sign in as Aman
        </button>
        <button
          type="button"
          className={`btn-sm ${currentUser === 'none' ? 'active' : ''}`}
          onClick={() => onSelectUser('none')}
          disabled={isLoading}
          aria-pressed={currentUser === 'none'}
        >
          Sign Out
        </button>
      </div>
    </section>
  );
};
