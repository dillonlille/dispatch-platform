import { useEffect, useMemo, useState } from 'react';
import type { PlatformHealth } from '../../../../../shared/contracts/index.js';
import { hashQuery, replaceHashQuery } from '../../../app/navigation.js';
import { useData } from '../../../app/api.js';
import { usePlatformJobs } from '../../../app/endpoints.js';
import { ErrorBox, Header, Loading, Tabs } from '../../../ui/index.js';
import { collectionHistory } from './collection-history.js';
import type { Diagnostics } from './types.js';
import { DiagnosticsCollections } from './DiagnosticsCollections.js';
import { DiagnosticsEmail } from './DiagnosticsEmail.js';
import { DiagnosticsOverview } from './DiagnosticsOverview.js';
import { DiagnosticsTestDsps } from './DiagnosticsTestDsps.js';

const tabs = ['overview', 'collections', 'email', 'test-dsps'];
function addressed() {
  const query = hashQuery();
  const tab = query.get('tab') ?? '';
  return {
    tab: tabs.includes(tab) ? tab : 'overview',
    source: query.get('source') ?? '',
    run: query.get('run') ?? '',
  };
}

export function DiagnosticsPage() {
  const health = useData<PlatformHealth>('/api/platform/health', 10000);
  const diagnostics = useData<Diagnostics>('/api/platform/diagnostics', 5000);
  const jobs = usePlatformJobs(3000);
  const sources = useMemo(() => collectionHistory(jobs.data ?? []), [jobs.data]);
  const [place, setPlace] = useState(addressed);
  // A link to another tab changes only the address's query, which does not remount the page.
  useEffect(() => {
    const changed = () => setPlace(addressed());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const go = (tab: string, source = place.source, run = '') => {
    setPlace({ tab, source, run });
    replaceHashQuery({ tab, ...(source && { source }), ...(run && { run }) });
  };
  const attention = sources.filter((source) => source.warnings.length).length;
  const mailFailed = health.data?.mail.failed ?? 0;
  const count = (text: string, value: number) => (
    <>
      {text}
      {value > 0 && <span className="tab-count">{value}</span>}
    </>
  );
  return (
    <>
      <Header title="Diagnostics" />
      <Tabs
        value={place.tab}
        onChange={(tab) => go(tab)}
        label="Diagnostics"
        items={[
          ['overview', 'Overview'],
          ['collections', count('Collections', attention)],
          ['email', count('Email', mailFailed)],
          ['test-dsps', 'Test DSPs'],
        ]}
      />
      <ErrorBox message={diagnostics.error || health.error || jobs.error} />
      {place.tab === 'overview' &&
        (health.data && diagnostics.data && jobs.data ? (
          <DiagnosticsOverview
            health={health.data}
            diagnostics={diagnostics.data}
            jobs={jobs.data}
            sources={sources}
            openSource={(source, run) => go('collections', source, run)}
            openEmail={() => go('email')}
          />
        ) : (
          <Loading />
        ))}
      {place.tab === 'collections' &&
        (jobs.data ? (
          <DiagnosticsCollections
            key={place.run}
            sources={sources}
            selected={place.source}
            run={place.run}
            onSelect={(source) => go('collections', source)}
          />
        ) : (
          <Loading />
        ))}
      {place.tab === 'email' &&
        (health.data ? (
          <DiagnosticsEmail mail={health.data.mail} onChanged={health.refresh} />
        ) : (
          <Loading />
        ))}
      {place.tab === 'test-dsps' &&
        (diagnostics.data ? (
          <DiagnosticsTestDsps diagnostics={diagnostics.data} refresh={diagnostics.refresh} />
        ) : (
          <Loading />
        ))}
    </>
  );
}
