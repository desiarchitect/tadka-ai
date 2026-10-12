import React, { useEffect, useState } from 'react';
import { apiClient } from './api/client.js';
import type { ApiDiagnostics, TriageResponse } from './api/types.js';
import { AuthStatus } from './components/AuthStatus.js';
import { CustomerView } from './components/CustomerView.js';
import { DeveloperPanel } from './components/DeveloperPanel.js';
import { Header } from './components/Header.js';

type UserOption = 'rahul' | 'aman' | 'none';

const CREDENTIALS: Record<'rahul' | 'aman', { email: string; pass: string }> = {
  rahul: { email: 'rahul@tadka.test', pass: 'Password123!' },
  aman: { email: 'aman@tadka.test', pass: 'Password123!' },
};

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<UserOption>('rahul');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>('rahul@tadka.test');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [result, setResult] = useState<TriageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ApiDiagnostics | null>(null);

  // Authenticate on initial load as Rahul (default demo caller)
  useEffect(() => {
    loginAs('rahul');
  }, []);

  const loginAs = async (user: UserOption) => {
    if (user === 'none') {
      setCurrentUser('none');
      setAccessToken(null);
      setUserEmail(null);
      return;
    }

    const creds = CREDENTIALS[user];
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.login(creds.email, creds.pass);
      setAccessToken(res.data.accessToken);
      setCurrentUser(user);
      setUserEmail(creds.email);
      setDiagnostics(res.diagnostics);
    } catch (err: unknown) {
      const diag = (err as { diagnostics?: ApiDiagnostics }).diagnostics;
      if (diag) setDiagnostics(diag);
      setError((err as Error).message || 'Authentication failed');
      setCurrentUser('none');
      setAccessToken(null);
      setUserEmail(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTriageSubmit = async (message: string) => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await apiClient.triage(message, accessToken);
      setResult(res.data);
      setDiagnostics(res.diagnostics);
    } catch (err: unknown) {
      const diag = (err as { diagnostics?: ApiDiagnostics }).diagnostics;
      if (diag) setDiagnostics(diag);
      setError((err as Error).message || 'Request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
  };

  return (
    <div className="app-container">
      <Header />
      <AuthStatus
        currentUser={currentUser}
        userEmail={userEmail}
        onSelectUser={loginAs}
        isLoading={isLoading}
      />
      <CustomerView
        onSubmit={handleTriageSubmit}
        isLoading={isLoading}
        result={result}
        error={error}
        onReset={handleReset}
      />
      <DeveloperPanel diagnostics={diagnostics} />
    </div>
  );
};

export default App;
