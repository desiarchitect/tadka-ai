import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, isCancelled, resolveApiBaseUrl } from './api/client.js';
import type { ApiDiagnostics, TriageResponse } from './api/types.js';
import { AuthStatus, type Identity } from './components/AuthStatus.js';
import { Capabilities } from './components/Capabilities.js';
import { CustomerView } from './components/CustomerView.js';
import { DeveloperPanel } from './components/DeveloperPanel.js';
import { Header } from './components/Header.js';
import { OrdersPanel } from './components/OrdersPanel.js';
import { RestaurantsPanel } from './components/RestaurantsPanel.js';
import { SideTabs } from './components/SideTabs.js';
import { demoCredentials, demoLoginEnabled, type DemoUser } from './demo.js';
import { useLoad } from './hooks/useLoad.js';

export const NO_API_URL_MESSAGE = 'This build has no API address, so it cannot reach the server. Rebuild it with VITE_API_URL set, for example: VITE_API_URL=https://api.example.com pnpm --filter @tadka/web build';
const SESSION_ENDED = 'Your session has ended. Please sign in again.';

type Session = { identity: Identity; token: string; refreshToken: string; id: number };

export const App: React.FC = () => {
  const demoLogin = demoLoginEnabled();
  // A production build has no default API address (see resolveApiBaseUrl): without one, nothing is sent anywhere.
  const apiConfigured = resolveApiBaseUrl() !== null;
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [result, setResult] = useState<TriageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostics | null>(null);
  // The assistant / sign-in request in flight, if any. Starting a new one or leaving the page cancels the old one.
  const inFlight = useRef<AbortController | null>(null);
  const sessionCounter = useRef(0);
  const refreshTokenRef = useRef<string | null>(null);

  // Restaurants and menus are public: they are not customer data, so a sign-in change does not clear them.
  const restaurants = useLoad((signal) => apiClient.restaurants(signal), apiConfigured);

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

  /**
   * Everything that belongs to the previous customer goes before anyone else's data is requested: the request in flight is
   * aborted, the session (so the orders panel, keyed by it, is unmounted with its requests and state) and every result,
   * error and diagnostic from that customer are cleared. The old refresh token is revoked on the server, best effort.
   */
  const clearCustomerScope = () => {
    inFlight.current?.abort();
    inFlight.current = null;
    setIsLoading(false);
    setSession(null);
    setResult(null);
    setError(null);
    setDiagnostics(null);
    const old = refreshTokenRef.current;
    refreshTokenRef.current = null;
    if (old) void apiClient.logout(old).catch(() => undefined);
  };

  const signIn = async (email: string, password: string, demoUser?: DemoUser) => {
    clearCustomerScope();
    setAuthMessage(null);
    const controller = begin();
    try {
      const res = await apiClient.login(email, password, controller.signal);
      if (controller.signal.aborted) return; // a newer sign-in or a sign-out replaced this one while the answer was arriving
      refreshTokenRef.current = res.data.refreshToken;
      setSession({ identity: { email, ...(demoUser ? { demoUser } : {}) }, token: res.data.accessToken, refreshToken: res.data.refreshToken, id: ++sessionCounter.current });
      setDiagnostics(res.diagnostics);
    } catch (err: unknown) {
      if (isCancelled(err)) return;
      const diag = (err as { diagnostics?: ApiDiagnostics }).diagnostics;
      if (diag) setDiagnostics(diag);
      setAuthMessage((err as Error).message || 'Authentication failed');
    } finally {
      end(controller);
    }
  };

  const selectDemoUser = (user: DemoUser | 'none') => {
    if (user === 'none') { clearCustomerScope(); setAuthMessage(null); return; }
    const creds = demoCredentials()?.[user];
    if (!creds) return; // demo sign-in is not part of this build
    void signIn(creds.email, creds.pass, user);
  };

  // Demo sign-in as Rahul on load, only in a build that has it switched on (VITE_DEMO_LOGIN=1).
  useEffect(() => {
    if (!demoLogin || !apiConfigured) return;
    selectDemoUser('rahul');
    return () => inFlight.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A data request came back 401: the access token is no longer valid. Nothing is retried silently.
  const onUnauthorized = useCallback(() => {
    clearCustomerScope();
    setAuthMessage(SESSION_ENDED);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTriageSubmit = async (message: string) => {
    const controller = begin();
    setResult(null);
    try {
      const res = await apiClient.triage(message, session?.token ?? null, controller.signal);
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
      <AuthStatus
        demoLogin={demoLogin && apiConfigured}
        apiConfigured={apiConfigured}
        identity={session?.identity ?? null}
        onSelectUser={selectDemoUser}
        onSignIn={(e, p) => void signIn(e, p)}
        onSignOut={() => { clearCustomerScope(); setAuthMessage(null); }}
        isLoading={isLoading}
        message={authMessage}
      />
      <main className="app-main product-grid">
        <div className="col-main">
          <CustomerView
            onSubmit={handleTriageSubmit}
            onCancel={handleCancel}
            isLoading={isLoading}
            result={result}
            error={error}
            onReset={handleReset}
            unavailableReason={!apiConfigured ? NO_API_URL_MESSAGE : session || demoLogin ? null : 'Sign in to use the assistant.'}
          />
          <Capabilities />
        </div>
        <div className="col-side">
          {apiConfigured ? (
            <SideTabs
              label="Orders and restaurants"
              tabs={[
                {
                  id: 'orders', label: 'Orders',
                  panel: session
                    ? <OrdersPanel key={session.id} token={session.token} restaurants={restaurants.state} onUnauthorized={onUnauthorized} />
                    : <section className="panel" aria-labelledby="orders-signed-out"><h2 id="orders-signed-out" className="panel-title">Your orders</h2><p className="muted">Sign in to see your orders.</p></section>,
                },
                { id: 'restaurants', label: 'Restaurants', panel: <RestaurantsPanel restaurants={restaurants.state} onRetry={restaurants.reload} /> },
              ]}
            />
          ) : (
            <section className="panel"><h2 className="panel-title">Orders and restaurants</h2><p className="muted">Unavailable: this build has no API address.</p></section>
          )}
        </div>
      </main>
      <DeveloperPanel diagnostics={diagnostics} />
    </div>
  );
};

export default App;
