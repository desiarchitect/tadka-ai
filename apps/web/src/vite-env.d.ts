/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** "1" turns on the built-in demo sign-in (Rahul / Aman). Unset in production builds. */
  readonly VITE_DEMO_LOGIN?: string;
}
