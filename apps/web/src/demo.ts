// The demo sign-in. The seeded accounts and their password exist only in the branch that is built with
// VITE_DEMO_LOGIN=1: when it is unset, the bundler removes the branch below, so the credentials are not
// in the production bundle at all (scripts/check-bundle.mjs checks that).
// Read at call time, not at import time, so a test can switch it on and off.
export type DemoUser = 'rahul' | 'aman';
export type DemoCredentials = Record<DemoUser, { email: string; pass: string }>;

export function demoLoginEnabled(): boolean {
  return import.meta.env.VITE_DEMO_LOGIN === '1';
}

export function demoCredentials(): DemoCredentials | null {
  if (import.meta.env.VITE_DEMO_LOGIN !== '1') return null;
  return {
    rahul: { email: 'rahul@tadka.test', pass: 'Password123!' },
    aman: { email: 'aman@tadka.test', pass: 'Password123!' },
  };
}
