import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { localDate, shiftDate } from '../../shared/meal-breaks.js';

function validDay(value: string, today: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > today) return false;
  try {
    return shiftDate(value, 0) === value;
  } catch {
    return false;
  }
}

// Collection accepts dates up to the DSP's business date, so a viewer in another
// timezone must see and select the DSP's day rather than their own.
export function usePaycomDate(dspId: string, timezone: string) {
  const today = localDate(timezone);
  const key = `dispatch:paycom-date:${dspId}`;
  const [selectedDate, setDate] = useState(() => {
    try {
      const saved = sessionStorage.getItem(key);
      if (saved && validDay(saved, today)) return saved;
    } catch {
      // Date navigation still works when browser storage is unavailable.
    }
    return today;
  });
  const date = validDay(selectedDate, today) ? selectedDate : today;
  const selectDate = (value: string) => {
    if (!validDay(value, today)) return;
    setDate(value);
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // The shared in-memory selection remains available across tabs.
    }
  };
  return { date, today, selectDate };
}

export function PaycomDateControls({
  date,
  today,
  onChange,
}: {
  date: string;
  today: string;
  onChange: (date: string) => void;
}) {
  const select = (value: string) => {
    if (validDay(value, today)) onChange(value);
  };
  return (
    <div className="paycom-date-controls paycom-date-controls-compact">
      <button
        className="icon-button"
        aria-label="Previous day"
        disabled={date <= '2000-01-01'}
        onClick={() => select(shiftDate(date, -1))}
      >
        <ChevronLeft size={16} />
      </button>
      <label>
        <span className="sr-only">Date</span>
        <input
          type="date"
          aria-label="Paycom date"
          min="2000-01-01"
          max={today}
          value={date}
          onChange={(event) => select(event.target.value)}
        />
      </label>
      <button
        className="icon-button"
        aria-label="Next day"
        disabled={date >= today}
        onClick={() => select(shiftDate(date, 1))}
      >
        <ChevronRight size={16} />
      </button>
      <button disabled={date === today} onClick={() => select(today)}>
        Today
      </button>
    </div>
  );
}
