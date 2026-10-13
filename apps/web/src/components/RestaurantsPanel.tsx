import React, { useState } from 'react';
import { apiClient } from '../api/client.js';
import type { Restaurant } from '../api/types.js';
import { useLoad, type Load } from '../hooks/useLoad.js';
import { rupees } from '../lib/format.js';

type Props = { restaurants: Load<Restaurant[]>; onRetry: () => void };

/** Restaurants and their menus, exactly as the API lists them: a name, a city, and menu items with a price. */
export const RestaurantsPanel: React.FC<Props> = ({ restaurants, onRetry }) => (
  <section aria-labelledby="restaurants-heading" className="panel">
    <h2 id="restaurants-heading" className="panel-title">Restaurants</h2>
    {restaurants.status === 'loading' && <p role="status" className="muted">Loading restaurants…</p>}
    {restaurants.status === 'error' && (
      <div className="error-card" role="alert">
        <div><div className="error-title">Could not load restaurants</div><div className="error-msg">{restaurants.message}</div></div>
        <button type="button" className="btn-sm" onClick={onRetry}>Retry</button>
      </div>
    )}
    {restaurants.status === 'ok' && restaurants.data.length === 0 && <p className="muted">No restaurants are listed right now.</p>}
    {restaurants.status === 'ok' && restaurants.data.length > 0 && (
      <ul className="plain-list">
        {restaurants.data.map((r) => <RestaurantRow key={r.id} restaurant={r} />)}
      </ul>
    )}
  </section>
);

const RestaurantRow: React.FC<{ restaurant: Restaurant }> = ({ restaurant }) => {
  const [open, setOpen] = useState(false);
  const bodyId = `menu-${restaurant.id}`;
  return (
    <li className="row-card">
      <div className="row-head">
        <div className="row-main">
          <span className="row-title">{restaurant.name}</span>
          <span className="muted">{restaurant.city}</span>
        </div>
        <button type="button" className="btn-sm" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide menu' : 'Show menu'}
          <span className="sr-only"> for {restaurant.name}</span>
        </button>
      </div>
      <div id={bodyId} hidden={!open}>{open && <Menu restaurantId={restaurant.id} name={restaurant.name} />}</div>
    </li>
  );
};

// Mounted only while open, so each opening reads the current menu from the API.
const Menu: React.FC<{ restaurantId: string; name: string }> = ({ restaurantId, name }) => {
  const { state, reload } = useLoad((signal) => apiClient.menu(restaurantId, signal));
  if (state.status === 'loading') return <p role="status" className="muted">Loading menu…</p>;
  if (state.status === 'error') {
    return (
      <div className="error-card" role="alert">
        <div><div className="error-title">Could not load the menu</div><div className="error-msg">{state.message}</div></div>
        <button type="button" className="btn-sm" onClick={reload}>Retry</button>
      </div>
    );
  }
  if (state.data.items.length === 0) return <p className="muted">This restaurant has no menu items listed.</p>;
  return (
    <ul className="menu-list" aria-label={`${name} menu`}>
      {state.data.items.map((i) => (
        <li key={i.id}><span>{i.name}{i.isVeg === true && <span className="status status-Confirmed veg-badge">Vegetarian</span>}</span><span className="price">{rupees(i.pricePaise)}</span></li>
      ))}
    </ul>
  );
};
