import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

describe('Tadka Visual Client (App)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Tadka branding, demo notice banner, and initial controls', async () => {
    // Mock auto-login
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'x-request-id': 'req-test-1', 'x-trace-id': 'trace-abc-123' }),
      json: async () => ({ accessToken: 'mock-jwt-token', refreshToken: 'mock-refresh', expiresIn: 900 }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Tadka Food Assistant')).toBeInTheDocument();
      expect(screen.getByText(/Local Demo & Learning Environment/)).toBeInTheDocument();
      expect(screen.getByText('Customer Inquiry & Support Assistant')).toBeInTheDocument();
      expect(screen.getByText('Developer Demonstration Panel (Real Backend Telemetry)')).toBeInTheDocument();
      expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument();
    });
  });

  it('submits an inquiry and renders the actual backend triage response and diagnostics', async () => {
    const fetchMock = vi.fn();
    // First call: auto login
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'x-request-id': 'req-1', 'x-trace-id': 'trace-001' }),
      json: async () => ({ accessToken: 'token-rahul', refreshToken: 'refresh-rahul', expiresIn: 900 }),
    });
    // Second call: assist triage
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'x-request-id': 'req-2', 'x-trace-id': 'trace-xyz-789' }),
      json: async () => ({
        output: {
          intent: 'order_status',
          language: 'hinglish',
          needsHuman: false,
          summary: 'Customer asks why Paneer Butter Masala is 40 minutes late.',
        },
        usage: { inputTokens: 90, outputTokens: 30 },
        modelId: 'gpt-5.4-mini',
        authenticatedAs: { userId: '11111111-1111-4111-8111-111111111111', role: 'Customer' },
      }),
    });
    globalThis.fetch = fetchMock;

    render(<App />);

    // Wait for auto-login to finish
    await waitFor(() => {
      expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument();
    });

    const submitBtn = screen.getByRole('button', { name: /Submit to Assistant/i });
    fireEvent.click(submitBtn);

    // Verify loading or response
    await waitFor(() => {
      expect(screen.getByText('Intent: order status')).toBeInTheDocument();
      expect(screen.getByText('Language: hinglish')).toBeInTheDocument();
      expect(screen.getByText('Human Escalation: Not Required')).toBeInTheDocument();
      expect(screen.getByText('Customer asks why Paneer Butter Masala is 40 minutes late.')).toBeInTheDocument();
    });

    // Verify Developer Panel shows real values
    expect(screen.getByText('200 OK')).toBeInTheDocument();
    expect(screen.getAllByText('trace-xyz-789').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('req-2')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getByText(/90 in \/ 30 out/)).toBeInTheDocument();

    // Verify "Submit Another Inquiry" resets the result
    const resetBtn = screen.getByRole('button', { name: /Submit Another Inquiry/i });
    fireEvent.click(resetBtn);
    expect(screen.queryByText('Intent: order status')).not.toBeInTheDocument();
  });

  it('handles 401 unauthenticated request safely without crashing', async () => {
    const fetchMock = vi.fn();
    // Auto login
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ accessToken: 'token-rahul', refreshToken: 'ref', expiresIn: 900 }),
    });
    // Triage call returns 401
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'x-request-id': 'req-unauth-1', 'x-trace-id': 'trace-unauth-1' }),
      json: async () => ({ error: 'missing_token' }),
    });
    globalThis.fetch = fetchMock;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Rahul \(Customer\)/)).toBeInTheDocument();
    });

    const submitBtn = screen.getByRole('button', { name: /Submit to Assistant/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Authentication required/)).toBeInTheDocument();
      expect(screen.getByText('401 Unauthorized')).toBeInTheDocument();
      expect(screen.getByText('missing_token')).toBeInTheDocument();
    });
  });
});
