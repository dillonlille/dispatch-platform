import { useState } from 'react';
import type { DspView, SessionView } from '../../../../shared/contracts/index.js';
import { Header, Tabs } from '../../ui/index.js';
import { can } from '../../app/permissions.js';
import { connectionFeatures } from '../../app/features.js';
import { ConnectionsPage } from '../connections/index.js';
import { ThemeSection } from './ThemeSection.js';
import { hashQuery, replaceHashQuery } from '../../app/navigation.js';
import { ProfileBadge } from './ProfileBadge.js';
import { SecuritySettings } from './SecuritySettings.js';

export function SettingsPage({ session, view }: { session: SessionView; view?: DspView }) {
  const [requestedTab, setTab] = useState(hashQuery().get('tab') || 'general');
  const connections = can(view, 'connections.manage');
  const tabs = [
    // The id stays `general` so existing links to the tab keep working.
    ['general', 'Profile'],
    ['security', 'Security'],
    ...(connections ? [['connections', 'Connections']] : []),
    ['theme', 'Theme'],
  ];
  const tab = tabs.some(([id]) => id === requestedTab) ? requestedTab : 'general';
  return (
    <>
      <Header title="Settings" />
      <Tabs
        value={tab}
        onChange={(value) => {
          setTab(value);
          replaceHashQuery({ tab: value });
        }}
        items={tabs}
        label="Settings"
      />
      {tab === 'general' && <ProfileBadge session={session} view={view} />}
      {tab === 'security' && <SecuritySettings />}
      {tab === 'connections' && connections && view && (
        <div className="settings-connections">
          <ConnectionsPage
            development={session.providerMode === 'fixture'}
            timezone={view.dsp.timezone}
            providers={connectionFeatures(view.features).map((f) => f.id)}
          />
        </div>
      )}
      {tab === 'theme' && <ThemeSection userId={session.user.id} />}
    </>
  );
}
