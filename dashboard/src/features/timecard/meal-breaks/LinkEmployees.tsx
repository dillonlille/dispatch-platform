import { useState } from 'react';
import { api } from '../../../app/api.js';
import { ErrorBox, Modal, SearchInput } from '../../../ui/index.js';
import { fullName } from '../../../lib/meal-breaks.js';
import { type MealComparison } from '../../../../../shared/contracts/meals.js';
import { useAction } from '../../../app/useAction.js';

export function LinkEmployees({
  data: initialData,
  close,
  saved,
}: {
  data: MealComparison;
  close: () => void;
  saved: () => void;
}) {
  // Keep the reviewed roster and revision together even while the page polls.
  const [data] = useState(initialData);
  const selection = (id: string) => {
    const saved = data.links.links.find((l) => l.cortexId === id);
    return saved ? `paycom:${saved.paycomCode}` : data.links.separate?.includes(id) ? '' : 'auto';
  };
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.drivers.map((d) => [d.id, selection(d.id)])),
  );
  const [query, setQuery] = useState('');
  const changes = data.drivers
    .filter((d) => values[d.id] !== selection(d.id))
    .map((d) => ({
      cortexId: d.id,
      paycomCode: values[d.id]?.startsWith('paycom:') ? values[d.id]!.slice(7) : null,
      ...(values[d.id] === 'auto' ? { automatic: true } : {}),
    }));
  const save = useAction(
    async () => {
      await api('/api/dsp/paycom/employee-links', { revision: data.links.revision, changes });
      saved();
    },
    { inline: true },
  );
  const { busy, error } = save;
  return (
    <Modal
      title="Link employees"
      description="Unique names match automatically, including supported name variations. Override a match or link different names here. Saved choices apply to all dates in this DSP."
      onClose={() => {
        if (!busy) close();
      }}
      variant="sheet"
    >
      <ErrorBox message={error} />
      <div className="meal-link-tools">
        <SearchInput
          label="Search Flex drivers"
          placeholder="Search Flex drivers…"
          value={query}
          onChange={setQuery}
        />
      </div>
      <p className="muted">
        Automatic matching handles capitalization, punctuation, spacing, extra surnames, omitted
        suffixes and supported short names such as Alex/Alexander. Each match must be unique in both
        sources. Ambiguous names stay separate until you select the correct employee.
      </p>
      {!data.employees.length && (
        <p>
          No Paycom roster has been collected for this date. Choose a date with both sources to link
          employees.
        </p>
      )}
      <div className="meal-link-list">
        {data.drivers
          .filter((d) => fullName(d.name).toLowerCase().includes(query.toLowerCase()))
          .sort(
            (a, b) =>
              Number(b.matchType === 'unmatched') - Number(a.matchType === 'unmatched') ||
              fullName(a.name).localeCompare(fullName(b.name)),
          )
          .map((driver) => (
            <label key={driver.id}>
              <span>
                {fullName(driver.name)}
                <small>Flex · {driver.id}</small>
              </span>
              <select
                aria-label={`Paycom employee for ${fullName(driver.name)}`}
                disabled={busy}
                value={values[driver.id]}
                onChange={(e) => setValues({ ...values, [driver.id]: e.target.value })}
              >
                <option value="auto">
                  {driver.matchType === 'name'
                    ? `Automatic · ${fullName(data.employees.find((e) => e.code === driver.paycomCode)?.name ?? '')}`
                    : driver.matchType === 'unmatched'
                      ? 'Automatic · no unique match'
                      : 'Automatic · unique name'}
                </option>
                <option value="">Keep separate</option>
                {data.employees.map((e) => (
                  <option key={e.code} value={`paycom:${e.code}`}>
                    {fullName(e.name)} · {e.code}
                  </option>
                ))}
                {values[driver.id]?.startsWith('paycom:') &&
                  !data.employees.some((e) => `paycom:${e.code}` === values[driver.id]) && (
                    <option value={values[driver.id]}>
                      Saved employee · {values[driver.id]!.slice(7)}
                    </option>
                  )}
              </select>
            </label>
          ))}
      </div>
      <div className="form-actions">
        <button onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !changes.length}
          onClick={() => void save.run()}
        >
          {busy
            ? 'Saving…'
            : `Save ${changes.length || ''} ${changes.length === 1 ? 'link' : 'links'}`}
        </button>
      </div>
    </Modal>
  );
}
