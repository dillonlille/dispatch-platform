import { useUpdateState } from '../../app/browser-update.js';
import { useState } from 'react';
import { ArrowRight, RefreshCw, Settings } from 'lucide-react';
import type { Connection, DspView } from '../../../../shared/contracts/index.js';
import { paycomDefaults, type PaycomSettings } from '../../../../shared/paycom.js';
import { api, useData } from '../../app/api.js';
import { ErrorBox, Header, Loading, Tabs } from '../../ui/index.js';
import { can } from '../../app/permissions.js';
import { randomId } from '../../lib/random-id.js';
import { EmployeesPage } from './EmployeesPage.js';
import { TimecardsPage } from './TimecardsPage.js';
import { MealBreaksPage } from './meal-breaks/MealBreaksPage.js';
import { usePaycomDate } from './DateControls.js';
import { useAction } from '../../app/useAction.js';
import { dspHash, navigate } from '../../app/navigation.js';
import { SourceSyncStatus, type SyncSource } from './SourceSyncStatus.js';

export function PaycomPage({ view }: { view: DspView }) {
  const canCollect = can(view, 'collections.run');
  const [selectedTab, setTab] = useUpdateState<string | undefined>('paycom-tab', undefined);
  const { date, today, selectDate } = usePaycomDate(view.dsp.id, view.dsp.timezone);
  const preferences = useData<PaycomSettings>('/api/dsp/paycom/settings');
  const tab = selectedTab ?? 'timecards';
  const [syncRevision, setSyncRevision] = useState(0);
  const overview = useData<{
    connection: Connection;
    workforce: { collectedAt: string | null };
  }>('/api/dsp/paycom/status', 5000);
  const syncState = useData<{
    date: string;
    scopeAvailable: boolean;
    paycom: SyncSource;
    flex: SyncSource;
  }>(`/api/dsp/jobs/meal-breaks?date=${date}`, 5000, undefined, String(syncRevision));
  // The last known state stays up while another date loads so the page does not shift.
  const sourceState = syncState.data ?? syncState.stale;
  const sourceCurrent = syncState.data?.date === date;
  const { error, refresh } = overview;
  const data = overview.data?.connection;
  const meals = tab === 'meal-breaks';
  const timecards = tab === 'timecards';
  const daily = timecards || meals;
  const activeSync = sourceState?.paycom.active || sourceState?.flex.active;
  const collectedAt = overview.data?.workforce.collectedAt;
  const refreshKey = `${sourceState?.paycom.collectedAt ?? collectedAt}:${sourceState?.flex.collectedAt}`;
  const syncUnavailable = daily
    ? !sourceState
      ? 'Checking connections…'
      : !sourceState.paycom.enabled
        ? 'Connect Paycom in Settings → Connections to sync.'
        : !sourceState.flex.enabled
          ? 'Connect Cortex in Settings → Connections to sync Flex.'
          : !sourceState.scopeAvailable
            ? 'Complete your DSP profile with a station code to sync Flex.'
            : ''
    : !data?.enabled
      ? 'Connect Paycom to sync.'
      : '';
  const canConnect = can(view, 'connections.manage');
  const sync = useAction(
    async () => {
      try {
        await api(daily ? '/api/dsp/jobs/meal-breaks' : '/api/dsp/jobs', {
          requestId: randomId(),
          ...(tab !== 'employees' ? { date } : {}),
        });
      } finally {
        refresh();
        // Keep every Sync Now disabled until status read after this request arrives.
        setSyncRevision((value) => value + 1);
      }
    },
    { success: () => (daily ? 'Flex and Paycom collections queued' : 'Paycom collection queued') },
  );
  const syncButton = canCollect && (
    <button
      disabled={
        !!syncUnavailable ||
        !syncState.data ||
        !!syncState.error ||
        sync.busy ||
        !!activeSync ||
        (daily && !sourceCurrent)
      }
      title={
        syncUnavailable ||
        (activeSync && 'A collection is in progress for this DSP.') ||
        (daily ? `Sync Flex and Paycom for ${date}` : 'Sync Paycom’s current pay period')
      }
      onClick={() => void sync.run()}
    >
      <RefreshCw size={16} />
      Sync now
    </button>
  );
  return (
    <div className={`paycom-page${daily ? ' paycom-daily-page' : ''}`}>
      <Header title="Timecard">
        {daily && canCollect && (
          <>
            <SourceSyncStatus
              name="Paycom"
              source={sourceState?.paycom}
              timezone={view.dsp.timezone}
              compact
            />
            <SourceSyncStatus
              name="Flex"
              source={sourceState?.flex}
              timezone={view.dsp.timezone}
              compact
            />
          </>
        )}
        {daily && syncButton}
        {can(view, 'timecard.manage') && (
          <button onClick={() => navigate(dspHash(view.dsp.id, 'paycom-settings'))}>
            {daily && <Settings size={16} />}
            Settings
          </button>
        )}
      </Header>
      {canConnect && <ErrorBox message={error} />}
      {canCollect && <ErrorBox message={syncState.error} />}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['timecards', 'Timecard'],
          ['meal-breaks', 'Meal Breaks'],
          ['employees', 'Employees'],
        ]}
        label="Timecard"
      />
      {!daily && (
        <section className="paycom-workspace-controls" aria-label="Date and sync">
          <div className="paycom-controls-row">{syncButton}</div>
          {canCollect && (
            <div className="paycom-sync-status">
              <SourceSyncStatus
                name="Paycom"
                source={sourceState?.paycom}
                timezone={view.dsp.timezone}
              />
              {sourceState?.flex.active && (
                <SourceSyncStatus
                  name="Flex"
                  source={sourceState.flex}
                  timezone={view.dsp.timezone}
                />
              )}
              {syncUnavailable && <span className="muted">{syncUnavailable}</span>}
            </div>
          )}
        </section>
      )}
      {daily && canCollect && syncUnavailable && (
        <p className="paycom-sync-unavailable muted">{syncUnavailable}</p>
      )}
      {tab === 'meal-breaks' ? (
        <MealBreaksPage
          date={date}
          today={today}
          onDateChange={selectDate}
          refreshKey={refreshKey}
          timezone={view.dsp.timezone}
          owner={can(view, 'timecard.manage')}
          preferences={preferences.data?.values ?? paycomDefaults}
        />
      ) : canConnect && !data && !error ? (
        <Loading />
      ) : canConnect && data && !data.enabled && !overview.data?.workforce.collectedAt ? (
        <button
          className="primary paycom-connect"
          onClick={() => navigate(dspHash(view.dsp.id, 'settings', { tab: 'connections' }))}
        >
          Connect Paycom
          <ArrowRight size={16} />
        </button>
      ) : (
        <div className="embedded-page">
          {tab === 'employees' ? (
            <EmployeesPage />
          ) : (
            <TimecardsPage
              date={date}
              onDateChange={selectDate}
              refreshKey={refreshKey}
              timezone={view.dsp.timezone}
              preferences={preferences.data?.values ?? paycomDefaults}
            />
          )}
        </div>
      )}
    </div>
  );
}
