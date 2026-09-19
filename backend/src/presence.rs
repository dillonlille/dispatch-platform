//! Who has the dashboard open. Held in memory only: presence is short-lived, and
//! after a restart every open dashboard reports itself again within one heartbeat.
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

// Dashboards beat every 30 seconds. Browsers slow the timers of a background tab
// to one a minute, which must not read as the member leaving.
const FRESH: Duration = Duration::from_secs(90);
const TABS: usize = 16;

struct Beat {
    active: bool,
    at: Instant,
}
type Members = HashMap<String, HashMap<String, Beat>>;

#[derive(Default)]
pub struct Presence(Mutex<HashMap<String, Members>>);
impl Presence {
    /// Records one dashboard tab. `active` is `None` when the tab is closing.
    pub fn beat(&self, dsp: &str, user: &str, tab: &str, active: Option<bool>) {
        self.beat_at(dsp, user, tab, active, Instant::now());
    }
    /// The most active of a member's open dashboards wins.
    pub fn status(&self, dsp: &str, user: &str) -> &'static str {
        self.status_at(dsp, user, Instant::now())
    }
    fn beat_at(&self, dsp: &str, user: &str, tab: &str, active: Option<bool>, now: Instant) {
        let mut dsps = self.0.lock().unwrap();
        let members = dsps.entry(dsp.into()).or_default();
        let tabs = members.entry(user.into()).or_default();
        match active {
            Some(active) if tabs.len() < TABS || tabs.contains_key(tab) => {
                tabs.insert(tab.into(), Beat { active, at: now });
            }
            Some(_) => {}
            None => {
                tabs.remove(tab);
            }
        }
        // Every beat sweeps its DSP, so closed dashboards never accumulate.
        members.retain(|_, tabs| {
            tabs.retain(|_, beat| now.duration_since(beat.at) < FRESH);
            !tabs.is_empty()
        });
        if members.is_empty() {
            dsps.remove(dsp);
        }
    }
    fn status_at(&self, dsp: &str, user: &str, now: Instant) -> &'static str {
        let dsps = self.0.lock().unwrap();
        let mut fresh = dsps
            .get(dsp)
            .and_then(|members| members.get(user))
            .into_iter()
            .flat_map(HashMap::values)
            .filter(|beat| now.duration_since(beat.at) < FRESH)
            .peekable();
        if fresh.peek().is_none() {
            "offline"
        } else if fresh.any(|beat| beat.active) {
            "active"
        } else {
            "idle"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn most_active_dashboard_wins_until_beats_stop() {
        let presence = Presence::default();
        let start = Instant::now();
        assert_eq!(presence.status_at("dsp", "user", start), "offline");
        presence.beat_at("dsp", "user", "one", Some(false), start);
        assert_eq!(presence.status_at("dsp", "user", start), "idle");
        presence.beat_at("dsp", "user", "two", Some(true), start);
        assert_eq!(presence.status_at("dsp", "user", start), "active");
        assert_eq!(presence.status_at("other", "user", start), "offline");
        presence.beat_at("dsp", "user", "two", None, start);
        assert_eq!(presence.status_at("dsp", "user", start), "idle");
        let later = start + FRESH;
        assert_eq!(presence.status_at("dsp", "user", later), "offline");
        presence.beat_at("dsp", "else", "one", Some(true), later);
        assert!(!presence.0.lock().unwrap()["dsp"].contains_key("user"));
    }

    #[test]
    fn one_member_cannot_hold_unbounded_tabs() {
        let presence = Presence::default();
        let now = Instant::now();
        for tab in 0..TABS + 4 {
            presence.beat_at("dsp", "user", &tab.to_string(), Some(true), now);
        }
        assert_eq!(presence.0.lock().unwrap()["dsp"]["user"].len(), TABS);
    }
}
