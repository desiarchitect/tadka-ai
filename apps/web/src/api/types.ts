export type TriageIntent = 'order_status' | 'refund_request' | 'menu_question' | 'complaint' | 'other';
export type TriageLanguage = 'en' | 'hi' | 'hinglish';

export type TriageOutput = {
  intent: TriageIntent;
  language: TriageLanguage;
  needsHuman: boolean;
  summary: string;
};

export type TriageResponse = {
  output: TriageOutput;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  modelId: string;
  authenticatedAs?: {
    userId: string;
    role: string;
  };
};

export type LoginResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type ApiDiagnostics = {
  httpStatus: number;
  statusText: string;
  outcome: 'success' | 'error';
  traceId: string | null;
  requestId: string | null;
  durationMs: number;
  authenticated: boolean;
  userRole?: string;
  userId?: string;
  modelId?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  errorCode?: string;
  errorMessage?: string;
  timestamp: string;
};
