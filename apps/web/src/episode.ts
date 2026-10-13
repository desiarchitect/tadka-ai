// What the assistant can really do in THIS build. This is a statement about the code on this branch, not a setting:
// when a later episode's server route and client code are merged in, its entry here is switched on in the same change.
export type Capability = { episode: string; name: string; available: boolean; what: string };

export const ASSISTANT_CAPABILITIES: Capability[] = [
  { episode: 'EP-0', name: 'Triage', available: true, what: 'Classifies the message (intent, language, escalation) and writes a short summary. It does not read your orders.' },
  { episode: 'EP-1', name: 'Structured intent', available: true, what: 'Returns one intent label from a fixed list (classification only: it does not read your orders). Server code, not the model, decides the next step.' },
  { episode: 'EP-2', name: 'Tool lookup', available: true, what: 'Looks up your orders and menus through validated, server-authorised read-only tools before answering. The page shows which tools ran and how each ended, not their arguments or results; the answer text is written by the server from those results.' },
  { episode: 'EP-3', name: 'Conversations and memory', available: true, what: 'Keeps your conversations on the server so a follow-up sees earlier turns (the newest whole turns that fit a size budget), and applies one saved preference that you choose, a vegetarian menu filter.' },
];

/** Whether this build has the EP-1 client features (the intent card and the direct order-status lookup). */
export const HAS_INTENT = ASSISTANT_CAPABILITIES.some((c) => c.episode === 'EP-1' && c.available);

/** Whether this build has the EP-2 client feature (the tool-calling question card). */
export const HAS_TOOLS = ASSISTANT_CAPABILITIES.some((c) => c.episode === 'EP-2' && c.available);

/** Whether this build has the EP-3 client feature (conversations and the saved preference). */
export const HAS_CONVERSATIONS = ASSISTANT_CAPABILITIES.some((c) => c.episode === 'EP-3' && c.available);
