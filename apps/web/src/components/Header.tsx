import React from 'react';

export const Header: React.FC = () => {
  return (
    <header className="header-card">
      <div className="brand-row">
        <div className="brand-title">
          <div className="brand-logo" aria-hidden="true">
            त
          </div>
          <div>
            <h1 className="brand-name">Tadka Food Assistant</h1>
            <p className="brand-sub">The Desi Architect &middot; AI Engineering &middot; Episode 0 Vertical Slice</p>
          </div>
        </div>
      </div>
      <div className="demo-banner" role="alert">
        <span aria-hidden="true">&#9888;&#65039;</span>
        <span>
          <strong>Local Demo &amp; Learning Environment:</strong> This page calls the local Tadka API. If the server runs in demo mode, its answers are labelled SIMULATED and no real model is used.
        </span>
      </div>
    </header>
  );
};
