mod common;
use common::{audits, seeded};
use dispatch_backend::db::{self, s};
use serde_json::json;

#[test]
fn dsp_audit_log_hides_platform_owner_actions() {
    let (_root, db) = seeded();
    let tenant = db
        .platform
        .one("SELECT id FROM dsps WHERE name='Northline Logistics'", [])
        .unwrap()
        .unwrap();
    let id = s(&tenant, "id");
    let user = |owner: i64| {
        db.platform
            .one(
                "SELECT id FROM users WHERE platform_owner=? LIMIT 1",
                [owner],
            )
            .unwrap()
            .unwrap()
    };
    let (owner, member) = (user(1), user(0));
    db.audit(Some(s(&owner, "id")), Some(id), "collection.requested", "")
        .unwrap();
    db.audit(Some(s(&member, "id")), Some(id), "schedule.updated", "")
        .unwrap();
    db.audit(None, Some(id), "collection.completed", "")
        .unwrap();
    let actions = |dsp| -> Vec<String> {
        audits(&db, dsp)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| s(row, "dspId") == id)
            .map(|row| s(row, "action").to_owned())
            .collect()
    };
    assert_eq!(
        actions(Some(id)),
        ["collection.completed", "schedule.updated"]
    );
    let platform = actions(None);
    assert!(platform.contains(&"collection.requested".to_owned()));
    assert!(platform.contains(&"development.fixtures_loaded".to_owned()));

    // Once the DSP shows Platform support, later owner actions appear there
    // without a name. Earlier ones, and managing the DSP itself, stay out.
    db.set_profile(id, json!({"supportVisible":true})).unwrap();
    let owner_id = s(&owner, "id");
    db.audit(Some(owner_id), Some(id), "dsp.owner_view_opened", "")
        .unwrap();
    db.audit(Some(owner_id), Some(id), "dsp.suspended", "")
        .unwrap();
    assert_eq!(
        actions(Some(id)),
        [
            "dsp.owner_view_opened",
            "collection.completed",
            "schedule.updated"
        ]
    );
    let log = audits(&db, Some(id)).unwrap();
    assert_eq!(s(&log[0], "actorName"), "Platform support");
    assert!(log[0]["actorId"].is_null());
    assert!(!log.to_string().contains(owner_id));
    let page = db
        .audit_page(&dispatch_backend::db::AuditQuery {
            dsp: Some(id),
            actor: "support",
            ..Default::default()
        })
        .map(|value| serde_json::to_value(value).unwrap())
        .unwrap();
    assert_eq!(page["total"], 1);
    assert!(
        page["actors"]
            .as_array()
            .unwrap()
            .contains(&json!({"id":"support","name":"Platform support"}))
    );
    // The platform's own log keeps the real name.
    let named = audits(&db, None).unwrap();
    assert_ne!(s(&named[0], "actorName"), "Platform support");
    db.set_profile(id, json!({"supportVisible":false})).unwrap();
    db.audit(Some(owner_id), Some(id), "dsp.owner_view_opened", "")
        .unwrap();
    assert_eq!(actions(Some(id)).len(), 3);
}

#[test]
fn audit_log_filters_pages_and_counts_by_area() {
    use dispatch_backend::db::AuditQuery;
    let (_root, db) = seeded();
    let one = |sql: &str| db.platform.one(sql, []).unwrap().unwrap();
    let tenant = one("SELECT id FROM dsps WHERE name='Northline Logistics'");
    let dsp = s(&tenant, "id");
    let member = one("SELECT id FROM users WHERE platform_owner=0 LIMIT 1");
    let member = s(&member, "id");
    db.audit(Some(member), Some(dsp), "schedule.created", "Morning 100%")
        .unwrap();
    db.audit(
        None,
        Some(dsp),
        "collection.failed",
        "paycom_verification_required",
    )
    .unwrap();
    db.audit(None, Some(dsp), "collection.completed", "")
        .unwrap();
    db.audit_with(
        Some(member),
        Some(dsp),
        "member.role_changed",
        "Manager",
        Some("Sam Rivera"),
        &[("role", Some("Dispatcher".into()), Some("Manager".into()))],
    )
    .unwrap();
    let page = |query: AuditQuery| {
        db.audit_page(&AuditQuery {
            dsp: Some(dsp),
            ..query
        })
        .map(|value| serde_json::to_value(value).unwrap())
        .unwrap()
    };
    let actions = |page: &serde_json::Value| -> Vec<String> {
        page["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| s(event, "action").to_owned())
            .collect()
    };
    let all = page(AuditQuery::default());
    assert_eq!(all["total"], 4);
    assert_eq!(
        all["counts"],
        json!({"team":1,"collections":2,"schedules":1,"failures":1})
    );
    assert_eq!(all["events"][0]["target"], "Sam Rivera");
    assert_eq!(
        all["events"][0]["changes"],
        json!([{"field":"role","from":"Dispatcher","to":"Manager"}])
    );
    assert_eq!(all["events"][0]["area"], "team");
    assert_eq!(all["events"][1]["changes"], json!([]));
    assert!(all["events"][1]["target"].is_null());
    assert!(all["events"][0].get("data").is_none());

    let failures = page(AuditQuery {
        area: "failures",
        ..AuditQuery::default()
    });
    assert_eq!(actions(&failures), ["collection.failed"]);
    // Area counts ignore the selected area so every chip keeps its number.
    assert_eq!(failures["counts"], all["counts"]);
    let system = page(AuditQuery {
        actor: "system",
        ..AuditQuery::default()
    });
    assert_eq!(
        actions(&system),
        ["collection.completed", "collection.failed"]
    );
    let by_member = page(AuditQuery {
        actor: member,
        ..AuditQuery::default()
    });
    assert_eq!(
        actions(&by_member),
        ["member.role_changed", "schedule.created"]
    );
    // Search reads the recorded subject, and treats LIKE wildcards literally.
    assert_eq!(
        actions(&page(AuditQuery {
            q: "rivera",
            ..AuditQuery::default()
        })),
        ["member.role_changed"]
    );
    assert_eq!(
        actions(&page(AuditQuery {
            q: "100%",
            ..AuditQuery::default()
        })),
        ["schedule.created"]
    );
    assert_eq!(
        page(AuditQuery {
            q: "1_0",
            ..AuditQuery::default()
        })["total"],
        0
    );
    assert_eq!(
        page(AuditQuery {
            from: "2999-01-01",
            ..AuditQuery::default()
        })["total"],
        0
    );

    let first = page(AuditQuery {
        limit: 3,
        ..AuditQuery::default()
    });
    assert_eq!(first["events"].as_array().unwrap().len(), 3);
    assert_eq!(first["total"], 4);
    let before = first["events"][2]["id"].as_i64().unwrap();
    assert_eq!(
        actions(&page(AuditQuery {
            before,
            ..AuditQuery::default()
        })),
        ["schedule.created"]
    );
    // A subject gathers its events by reference, and older ones by the name they kept.
    db.audit_ref(
        Some(member),
        Some(dsp),
        "role.updated",
        "Leads",
        Some("Dispatcher"),
        &[],
        Some(("role", "role_1")),
    )
    .unwrap();
    db.audit_with(
        Some(member),
        Some(dsp),
        "role.deleted",
        "Leads",
        Some("Leads"),
        &[],
    )
    .unwrap();
    assert_eq!(
        actions(&page(AuditQuery {
            subject: "role:role_1",
            named: "Leads",
            ..AuditQuery::default()
        })),
        ["role.deleted", "role.updated"]
    );
    assert_eq!(
        actions(&page(AuditQuery {
            subject: "role:role_1",
            ..AuditQuery::default()
        })),
        ["role.updated"]
    );
    let referenced = page(AuditQuery {
        subject: "role:role_1",
        ..AuditQuery::default()
    });
    assert_eq!(
        referenced["events"][0]["ref"],
        json!({"kind":"role","id":"role_1"})
    );
    // The platform's log narrows to one DSP; a DSP's own log ignores the filter.
    let everywhere = db
        .audit_page(&AuditQuery::default())
        .map(|value| serde_json::to_value(value).unwrap())
        .unwrap();
    let narrowed = db
        .audit_page(&AuditQuery {
            within: dsp,
            ..AuditQuery::default()
        })
        .map(|value| serde_json::to_value(value).unwrap())
        .unwrap();
    assert!(narrowed["total"].as_i64() < everywhere["total"].as_i64());
    assert!(
        narrowed["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| s(e, "dspId") == dsp)
    );
    assert!(
        everywhere["dsps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| s(d, "id") == dsp)
    );

    // Reopening a DSP within half an hour adds nothing; a year-old event is pruned.
    let visits = || {
        page(AuditQuery {
            q: "view_opened",
            ..AuditQuery::default()
        })["total"]
            .clone()
    };
    db.audit_visit(member, dsp, "dsp.view_opened", "").unwrap();
    db.audit_visit(member, dsp, "dsp.view_opened", "").unwrap();
    assert_eq!(visits(), 1);
    db.platform
        .exec(
            "UPDATE audit SET at=? WHERE action='dsp.view_opened'",
            [db::at(db::now() - 31 * 60 * 1000)],
        )
        .unwrap();
    db.audit_visit(member, dsp, "dsp.view_opened", "").unwrap();
    assert_eq!(visits(), 2);
    db.platform
        .exec(
            "UPDATE audit SET at=? WHERE action='schedule.created'",
            [db::at(db::now() - 366 * 24 * 60 * 60 * 1000)],
        )
        .unwrap();
    assert_eq!(db.prune_audit().unwrap(), 1);

    // An export returns what the filters match, then records that it was taken.
    let before = page(AuditQuery::default())["total"].as_i64().unwrap();
    let exported = db
        .audit_export(
            member,
            AuditQuery {
                dsp: Some(dsp),
                area: "team",
                limit: 1,
                ..AuditQuery::default()
            },
        )
        .map(|value| serde_json::to_value(value).unwrap())
        .unwrap();
    let rows = exported["events"].as_array().unwrap();
    assert!(rows.len() > 1 && rows.iter().all(|e| s(e, "area") == "team"));
    let after = page(AuditQuery::default());
    assert_eq!(after["total"].as_i64().unwrap(), before + 1);
    assert_eq!(s(&after["events"][0], "action"), "audit.exported");
    assert_eq!(s(&after["events"][0], "detail"), rows.len().to_string());

    let actors: Vec<_> = all["actors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|actor| s(actor, "id").to_owned())
        .collect();
    assert!(actors.contains(&"system".to_owned()) && actors.contains(&member.to_owned()));
}
