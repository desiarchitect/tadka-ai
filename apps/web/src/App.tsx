import React, { useEffect, useRef, useState } from 'react';
import { apiClient, isCancelled, resolveApiBaseUrl } from './api/client.js';
import type { ApiDiagnostics, TriageResponse } from './api/types.js';
import { AuthStatus } from './components/AuthStatus.js';
import { CustomerView } from './components/CustomerView.js';
import { DeveloperPanel } from './components/DeveloperPanel.js';
import { Header } from './components/Header.js';
import { demoCredentials, demoLoginEnabled, type DemoUser } from './demo.js';

type UserOption = DemoUser | 'none';

export const NO_API_URL_MESSAGE = 'This build has no API address, so it cannot reach the server. Rebuild it with VITE_API_URL set, for example: VITE_API_URL=https://api.example.com pnpm --filter @tadka/web build';

export const App: React.FC = () => {
  const demoLogin = demoLoginEnabled();
  // A production build has no default API address (see resolveApiBaseUrl): without one, nothing is sent anywhere.
  const apiConfigured = resolveApiBaseUrl() !== null;
  const [currentUser, setCurrentUser] = useState<UserOption>('none');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [result, setResult] = useState<TriageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostics | null>(null);
  // The request in flight, if any. Starting a new one or leaving the page cancels the old one.
  const inFlight = useRef<AbortController | null>(null);

  const begin = () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setIsLoading(true);
    setError(null);
    return controller;
  };
  const end = (controller: AbortController) => {
    if (inFlight.current === controller) { inFlight.current = null; setIsLoading(false); }
  };
  const failed = (err: unknown, fallback: string) => {
    const diag = (err as { diagnostics?: ApiDiagnostics }).diagnostics;
    if (diag) setDiagnostics(diag);
    setError((err as Error).message || fallback);
  };

  // Demo sign-in as Rahul on load, only in a build that has it switched on (VITE_DEMO_LOGIN=1).
  useEffect(() => {
    if (!demoLogin || !apiConfigured) return;
    void loginAs('rahul');
    return () => inFlight.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginAs = async (user: UserOption) => {
    if (user === 'none') {
      inFlight.current?.abort();
      inFlight.current = null;
      setIsLoading(false);
      setCurrentUser('none');
      setAccessToken(null);
      setUserEmail(null);
      return;
    }
    const creds = demoCredentials()?.[user];
    if (!creds) return; // demo sign-in is not part of this build
    const controller = begin();
    try {
      const res = await apiClient.login(creds.email, creds.pass, controller.signal);
      setAccessToken(res.data.accessToken);
      setCurrentUser(user);
      setUserEmail(creds.email);
      setDiagnostics(res.diagnostics);
    } catch (err: unknown) {
      if (isCancelled(err)) return;
      failed(err, 'Authentication failed');
      setCurrentUser('none');
      setAccessToken(null);
      setUserEmail(null);
    } finally {
      end(controller);
    }
  };

  const handleTriageSubmit = async (message: string) => {
    const controller = begin();
    setResult(null);
    try {
      const res = await apiClient.triage(message, accessToken, controller.signal);
      setResult(res.data);
      setDiagnostics(res.diagnostics);
    } catch (err: unknown) {
      if (isCancelled(err)) return;
      failed(err, 'Request failed');
    } finally {
      end(controller);
    }
  };

  const handleCancel = () => inFlight.current?.abort();

  const handleReset = () => {
    setResult(null);
    setError(null);
  };

  return (
    <div className="app-container">
      <Header />
      <main className="app-main">
        <AuthStatus
          demoLogin={demoLogin && apiConfigured}
          apiConfigured={apiConfigured}
          currentUser={currentUser}
          userEmail={userEmail}
          onSelectUser={loginAs}
          isLoading={isLoading}
        />
        <CustomerView
          onSubmit={handleTriageSubmit}
          onCancel={handleCancel}
          isLoading={isLoading}
          result={result}
          error={error}
          onReset={handleReset}
          unavailableReason={!apiConfigured ? NO_API_URL_MESSAGE : demoLogin ? null : 'Sign-in is not available in this build, so the assistant cannot be used here.'}
        />
        <DeveloperPanel diagnostics={diagnostics} />
      </main>
    </div>
  );
};

export default App;
