import React, { useState } from 'react';
import type { DemoUser } from '../demo.js';

export type Identity = { email: string; demoUser?: DemoUser };

interface AuthStatusProps {
  demoLogin: boolean;
  /** false: this build has no API address (a production build without VITE_API_URL). */
  apiConfigured?: boolean;
  identity: Identity | null;
  /** Demo buttons: a seeded customer, or 'none' to sign out. */
  onSelectUser: (user: DemoUser | 'none') => void;
  onSignIn: (email: string, password: string) => void;
  onSignOut: () => void;
  isLoading: boolean;
  /** Why the page is signed out or sign-in failed: shown once, next to the controls. */
  message?: string | null;
}

export const AuthStatus: React.FC<AuthStatusProps> = ({ demoLogin, apiConfigured = true, identity, onSelectUser, onSignIn, onSignOut, isLoading, message = null }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const current = identity?.demoUser ?? (identity ? 'other' : 'none');

  if (!apiConfigured) {
    return (
      <section className="auth-bar" aria-label="Authentication Controls">
        <div className="auth-info">
          <span className="auth-badge unauthenticated" role="status">&#9675; Not signed in. This build has no API address configured.</span>
        </div>
      </section>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password || isLoading) return;
    onSignIn(email.trim(), password);
    setPassword('');
  };

  return (
    <section className="auth-bar" aria-label="Authentication Controls">
      <div className="auth-info">
        <span className="diag-label">{demoLogin ? 'Active Caller:' : 'Account:'}</span>
        {identity ? (
          <span className="auth-badge authenticated">
            &#9679; {identity.demoUser ? `${identity.demoUser === 'rahul' ? 'Rahul' : 'Aman'} (Customer)` : 'Signed in'} ({identity.email})
          </span>
        ) : (
          <span className="auth-badge unauthenticated" role="status">
            &#9675; {demoLogin ? 'Unauthenticated (Demonstrates 401 Rejection)' : 'Not signed in. The demo sign-in is switched off in this build.'}
          </span>
        )}
      </div>

      {message && <p className="notice notice-error" role="alert">{message}</p>}

      {demoLogin && (
        <div className="auth-actions">
          <span className="diag-label">Simulate Identity:</span>
          <button type="button" className={`btn-sm ${current === 'rahul' ? 'active' : ''}`} onClick={() => onSelectUser('rahul')} disabled={isLoading} aria-pressed={current === 'rahul'}>Sign in as Rahul</button>
          <button type="button" className={`btn-sm ${current === 'aman' ? 'active' : ''}`} onClick={() => onSelectUser('aman')} disabled={isLoading} aria-pressed={current === 'aman'}>Sign in as Aman</button>
          <button type="button" className={`btn-sm ${current === 'none' ? 'active' : ''}`} onClick={() => onSelectUser('none')} disabled={isLoading} aria-pressed={current === 'none'}>Sign Out</button>
        </div>
      )}

      {!demoLogin && identity && (
        <div className="auth-actions"><button type="button" className="btn-sm" onClick={onSignOut}>Sign Out</button></div>
      )}

      {!identity && (
        <form className="signin-form" onSubmit={submit} aria-label="Sign in">
          <div className="input-group">
            <label htmlFor="signin-email" className="diag-label">Email</label>
            <input id="signin-email" type="email" autoComplete="username" className="text-input" value={email} onChange={(e) => setEmail(e.target.value)} disabled={isLoading} required />
          </div>
          <div className="input-group">
            <label htmlFor="signin-password" className="diag-label">Password</label>
            <input id="signin-password" type="password" autoComplete="current-password" className="text-input" value={password} onChange={(e) => setPassword(e.target.value)} disabled={isLoading} required />
          </div>
          <button type="submit" className="btn-primary" disabled={isLoading || !email.trim() || !password}>{isLoading ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}
    </section>
  );
};
