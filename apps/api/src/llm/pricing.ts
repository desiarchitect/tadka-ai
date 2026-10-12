// Prices are per (provider, model), never per model alone: the same model can be priced
// differently on Foundry and on the direct API, and reusing one provider's numbers for the
// other would make the budget guard wrong without any error. A pair with no row here is
// refused before anything is sent.
//
// Units: USD per 1M tokens. `outputPerM` is applied to the output total the provider
// reports, which already includes reasoning tokens; they are not charged a second time.
import type { Provider } from './types.js';

export type PriceRow = {
  provider: Provider;
  model: string;
  tier: string; // the deployment or pricing tier these numbers are for
  inputPerM: number;
  outputPerM: number;
  source: string;
  checkedOn: string; // ISO date the numbers were last checked
};

export const priceKey = (provider: Provider, model: string) => `${provider}:${model}`;

// Foundry rows: Global Standard, from the Azure Retail Prices API as shown on azurespeed.com.
// Data Zone deployments cost about 10-20% more.
// There is deliberately NO row for provider "openai" yet: the direct-API path refuses to send
// until someone enters the current numbers from OpenAI's pricing page and the date.
const ROWS: PriceRow[] = [
  { provider: 'azure', model: 'gpt-5.4-mini', tier: 'Global Standard', inputPerM: 0.75, outputPerM: 4.5, source: 'Azure Retail Prices API via azurespeed.com', checkedOn: '2026-10-11' },
  { provider: 'azure', model: 'gpt-5.4-nano', tier: 'Global Standard', inputPerM: 0.2, outputPerM: 1.25, source: 'Azure Retail Prices API via azurespeed.com', checkedOn: '2026-10-11' },
];

export const PRICES: Readonly<Record<string, PriceRow>> = Object.freeze(Object.fromEntries(ROWS.map((r) => [priceKey(r.provider, r.model), r])));
export const isPriced = (key: string) => Object.hasOwn(PRICES, key);
