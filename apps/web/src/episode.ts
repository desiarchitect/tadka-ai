// What the assistant can really do in THIS build. This is a statement about the code on this branch, not a setting:
// when a later episode's server route and client code are merged in, its entry here is switched on in the same change.
export type Capability = { episode: string; name: string; available: boolean; what: string };

export const ASSISTANT_CAPABILITIES: Capability[] = [
  { episode: 'EP-0', name: 'Triage', available: true, what: 'Classifies the message (intent, language, escalation) and writes a short summary. It does not read your orders.' },
  { episode: 'EP-1', name: 'Structured intent', available: false, what: 'Returns one intent label from a fixed list, then server code decides the next step.' },
  { episode: 'EP-2', name: 'Tool lookup', available: false, what: 'Looks up your orders through validated, authorised tools before answering.' },
];
