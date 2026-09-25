//! Guardrails for the route table in `backend/src/http/routes/`.
use dispatch_backend::{
    http::{
        Access::{self, Dsp, PlatformOwner, Public, Session},
        Work::{self, Async, Memory, Read, Write},
        table,
    },
    roles,
};
use std::collections::BTreeSet;

const TEAM: &str = "members.invite|members.manage|roles.manage";
const LIVE: &str = "timecard.view|collections.run";
const WAKES_SCHEDULER: bool = true;

type Row = (&'static str, &'static str, Access, Work, bool);

// Every endpoint: who may call it, which database access its work runs under,
// and whether it wakes the scheduler. The list was written from the dispatcher
// this table replaced, so it is the proof that no route changed its permission.
//
// Adding an endpoint? Add its row here too. A reviewer then sees, in one line,
// who can reach it, and a permission changed by accident fails this test.
#[rustfmt::skip]
const INVENTORY: &[Row] = &[
    ("GET", "/api/health", Public, Memory, false),
    ("GET", "/api/browser-update", Public, Memory, false),
    ("POST", "/api/auth/login", Public, Async, false),
    ("POST", "/api/auth/logout", Session, Write, false),
    ("POST", "/api/auth/password", Session, Async, false),
    ("POST", "/api/auth/forgot-password", Public, Write, false),
    ("POST", "/api/auth/reset-password", Public, Async, false),
    ("GET", "/api/invitations/{token}", Public, Write, false),
    ("POST", "/api/invitations/{token}/accept", Public, Async, false),
    ("GET", "/api/auth/security/sessions", Session, Read, false),
    ("POST", "/api/auth/security/sessions/{id}/revoke", Session, Write, false),
    ("POST", "/api/auth/security/sessions/revoke-others", Session, Write, false),
    ("POST", "/api/auth/security/sessions/revoke-all", Session, Write, false),
    ("GET", "/api/session", Session, Read, false),
    ("POST", "/api/session/dsp", Session, Write, false),

    ("GET", "/api/platform/dsps", PlatformOwner, Read, false),
    ("POST", "/api/platform/dsps", PlatformOwner, Write, WAKES_SCHEDULER),
    ("POST", "/api/platform/dsps/{id}/retry", PlatformOwner, Write, WAKES_SCHEDULER),
    ("POST", "/api/platform/dsps/{id}/status", PlatformOwner, Async, false),
    ("POST", "/api/platform/dsps/{id}/support-visibility", PlatformOwner, Async, false),
    ("GET", "/api/platform/dsps/{id}/features", PlatformOwner, Read, false),
    ("POST", "/api/platform/dsps/{id}/features", PlatformOwner, Async, false),
    ("POST", "/api/platform/dsps/{id}/remove", PlatformOwner, Async, false),
    ("POST", "/api/platform/dsps/{id}/restore", PlatformOwner, Async, false),
    ("GET", "/api/platform/jobs", PlatformOwner, Read, false),
    ("GET", "/api/platform/audit", PlatformOwner, Read, false),
    ("POST", "/api/platform/audit/export", PlatformOwner, Write, false),
    ("GET", "/api/platform/health", PlatformOwner, Read, false),
    ("GET", "/api/platform/mail", PlatformOwner, Read, false),
    ("POST", "/api/platform/mail/{id}/retry", PlatformOwner, Write, false),
    ("POST", "/api/platform/mail/{id}/discard", PlatformOwner, Write, false),
    ("GET", "/api/platform/diagnostics", PlatformOwner, Read, false),
    ("POST", "/api/platform/diagnostics", PlatformOwner, Write, false),

    ("GET", "/api/dsp/uniforms", Dsp("uniforms.view"), Read, false),
    ("GET", "/api/dsp/uniforms/updates", Dsp("uniforms.view"), Async, false),
    ("GET", "/api/dsp/uniforms/history", Dsp("uniforms.view"), Read, false),
    ("POST", "/api/dsp/uniforms/initialize", Dsp("uniforms.manage"), Write, false),
    ("POST", "/api/dsp/uniforms", Dsp("uniforms.manage"), Write, false),
    ("POST", "/api/dsp/uniforms/{id}", Dsp("uniforms.manage"), Write, false),
    ("POST", "/api/dsp/uniforms/{id}/archive", Dsp("uniforms.manage"), Write, false),
    ("POST", "/api/dsp/uniforms/stock/{id}", Dsp("uniforms.adjust"), Write, false),
    ("GET", "/api/dsp/collection-updates", Dsp(LIVE), Async, false),
    ("POST", "/api/dsp/presence", Dsp("access"), Async, false),
    ("GET", "/api/dsp/employees", Dsp("timecard.view"), Read, false),
    ("GET", "/api/dsp/employees/{code}", Dsp("timecard.view"), Read, false),
    ("POST", "/api/dsp/employees/{code}/sync", Dsp("collections.run"), Write, false),
    ("GET", "/api/dsp/timecards", Dsp("timecard.view"), Read, false),
    ("GET", "/api/dsp/paycom/status", Dsp("timecard.view"), Read, false),
    ("GET", "/api/dsp/paycom/settings", Dsp("timecard.view"), Read, false),
    ("POST", "/api/dsp/paycom/settings", Dsp("timecard.manage"), Write, false),
    ("GET", "/api/dsp/paycom/meal-breaks", Dsp("timecard.view"), Read, false),
    ("POST", "/api/dsp/paycom/employee-links", Dsp("timecard.manage"), Write, false),
    ("GET", "/api/dsp/cortex/meal-breaks", Dsp("timecard.view"), Read, false),
    ("POST", "/api/dsp/cortex/meal-breaks/collect", Dsp("collections.run"), Write, false),
    ("GET", "/api/dsp/jobs", Dsp("collections.run"), Read, false),
    ("POST", "/api/dsp/jobs", Dsp("collections.run"), Write, false),
    ("POST", "/api/dsp/jobs/{id}/cancel", Dsp("collections.run"), Async, false),
    ("GET", "/api/dsp/jobs/meal-breaks", Dsp("timecard.view"), Read, false),
    ("POST", "/api/dsp/jobs/meal-breaks", Dsp("collections.run"), Write, false),
    ("GET", "/api/dsp/scorecard/weeks", Dsp("timecard.view"), Read, false),
    ("POST", "/api/dsp/scorecard/collect", Dsp("collections.run"), Write, false),
    ("GET", "/api/dsp/schedules", Dsp("timecard.manage"), Read, false),
    ("POST", "/api/dsp/schedules", Dsp("timecard.manage"), Write, WAKES_SCHEDULER),
    ("POST", "/api/dsp/schedules/preview", Dsp("timecard.manage"), Write, false),
    ("POST", "/api/dsp/schedules/{key}", Dsp("timecard.manage"), Write, WAKES_SCHEDULER),
    ("POST", "/api/dsp/schedules/{key}/enabled", Dsp("timecard.manage"), Write, WAKES_SCHEDULER),
    ("POST", "/api/dsp/schedules/{key}/remove", Dsp("timecard.manage"), Write, WAKES_SCHEDULER),
    ("POST", "/api/dsp/profile", Dsp("settings.manage"), Write, WAKES_SCHEDULER),
    ("GET", "/api/dsp/members", Dsp(TEAM), Read, false),
    ("POST", "/api/dsp/members/invite", Dsp("members.invite"), Write, false),
    ("POST", "/api/dsp/members/{id}", Dsp("members.manage"), Write, false),
    ("GET", "/api/dsp/invitations", Dsp("members.invite"), Read, false),
    ("POST", "/api/dsp/invitations/revoke", Dsp("members.invite"), Write, false),
    ("GET", "/api/dsp/roles", Dsp(TEAM), Read, false),
    ("POST", "/api/dsp/roles", Dsp("roles.manage"), Write, false),
    ("POST", "/api/dsp/roles/{id}", Dsp("roles.manage"), Write, false),
    ("POST", "/api/dsp/roles/{id}/remove", Dsp("roles.manage"), Write, false),
    ("GET", "/api/dsp/connections", Dsp("connections.manage"), Read, false),
    ("GET", "/api/dsp/connections/{provider}", Dsp("connections.manage"), Async, false),
    ("POST", "/api/dsp/connections/{provider}", Dsp("connections.manage"), Async, false),
    ("POST", "/api/dsp/connections/{provider}/save", Dsp("connections.manage"), Async, false),
    ("POST", "/api/dsp/connections/{provider}/check", Dsp("connections.manage"), Async, false),
    ("POST", "/api/dsp/connections/{provider}/disable", Dsp("connections.manage"), Async, false),
    ("POST", "/api/dsp/connections/{provider}/verify", Dsp("connections.manage"), Async, false),
    ("GET", "/api/dsp/connections/{provider}/screenshot", Dsp("connections.manage"), Async, false),
    ("POST", "/api/dsp/connections/{provider}/assist", Dsp("connections.manage"), Async, false),
    ("POST", "/api/dsp/connections/{provider}/submit", Dsp("connections.manage"), Async, false),
];

fn describe(rows: impl IntoIterator<Item = Row>) -> BTreeSet<String> {
    rows.into_iter()
        .map(|(method, path, access, work, wakes)| {
            let wakes = if wakes { " wakes-scheduler" } else { "" };
            format!("{method} {path} {access:?} {work:?}{wakes}")
        })
        .collect()
}

#[test]
fn the_route_table_is_exactly_the_inventory() {
    let registered = describe(table().iter().map(|route| {
        let method = if route.method == "GET" { "GET" } else { "POST" };
        let wakes = route.invalidates_schedules;
        (method, route.path, route.access, route.work, wakes)
    }));
    let expected = describe(INVENTORY.iter().copied());
    let missing: Vec<_> = expected.difference(&registered).collect();
    let unlisted: Vec<_> = registered.difference(&expected).collect();
    assert!(
        missing.is_empty() && unlisted.is_empty(),
        "in the inventory but not registered: {missing:#?}\nregistered but not in the inventory: {unlisted:#?}"
    );
}

#[test]
fn no_route_is_registered_twice_and_only_get_and_post_exist() {
    let mut seen = BTreeSet::new();
    for route in table() {
        assert!(
            ["GET", "POST"].contains(&route.method.as_str()),
            "{}",
            route.path
        );
        assert!(
            seen.insert((route.method.to_string(), route.path)),
            "{} {} is registered twice",
            route.method,
            route.path
        );
        assert!(route.path.starts_with("/api/"), "{}", route.path);
        // The Origin and CSRF checks rest on reads never changing anything for a session.
        if route.method == "GET" && route.work == Write {
            assert_eq!(route.access, Public, "{}", route.path);
        }
        assert!(
            !route.invalidates_schedules || route.work == Write,
            "{} wakes the scheduler without being a write",
            route.path
        );
    }
}

#[test]
fn dsp_routes_only_name_permissions_that_exist() {
    for route in table() {
        if let Dsp(expression) = route.access {
            for permission in expression.split('|') {
                assert!(
                    roles::PERMISSIONS.contains(&permission) || permission == roles::ACCESS,
                    "{} {} requires unknown permission {permission:?}",
                    route.method,
                    route.path
                );
            }
        }
    }
}
