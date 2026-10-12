import React, { useRef, useState } from 'react';

type Tab = { id: string; label: string; panel: React.ReactNode };

/** Accessible tabs (arrow keys, Home, End). Every panel stays mounted, so switching tabs never loses what was loaded. */
export const SideTabs: React.FC<{ tabs: Tab[]; label: string }> = ({ tabs, label }) => {
  const [active, setActive] = useState(tabs[0]!.id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: React.KeyboardEvent, index: number) => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : move === undefined ? null : (index + move + tabs.length) % tabs.length;
    if (to === null) return;
    e.preventDefault();
    const id = tabs[to]!.id;
    setActive(id);
    refs.current[id]?.focus();
  };
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.id} ref={(el) => { refs.current[t.id] = el; }} type="button" role="tab" id={`tab-${t.id}`}
            aria-selected={active === t.id} aria-controls={`tabpanel-${t.id}`} tabIndex={active === t.id ? 0 : -1}
            className={`tab ${active === t.id ? 'active' : ''}`} onClick={() => setActive(t.id)} onKeyDown={(e) => onKey(e, i)}
          >{t.label}</button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`tabpanel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={active !== t.id}>{t.panel}</div>
      ))}
    </div>
  );
};
