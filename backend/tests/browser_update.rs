use dispatch_backend::{config::Config, http::browser_update_ready};
use serde_json::json;

#[test]
fn browser_refresh_requires_completed_matching_activation() {
    let root = tempfile::tempdir().unwrap();
    let mut config = Config::load().unwrap();
    config.root = root.path().into();
    config.development = false;
    config.release = "new-digest".into();
    std::fs::create_dir_all(config.platform()).unwrap();
    for (environment, channel) in [("production", "production"), ("preview", "dev")] {
        config.environment = environment.into();
        let status = config.platform().join(format!("{channel}-update.json"));
        let receipt = config.platform().join(format!("{channel}-activation.json"));
        assert!(!browser_update_ready(&config));
        for (state, digest, expected) in [
            ("ready", "old-digest", false),
            ("failed", "new-digest", false),
            ("ready", "new-digest", true),
        ] {
            std::fs::write(&status, json!({"status":state,"digest":digest}).to_string()).unwrap();
            assert_eq!(browser_update_ready(&config), expected);
        }
        std::fs::write(&receipt, "{}").unwrap();
        assert!(!browser_update_ready(&config));
        std::fs::remove_file(&receipt).unwrap();
        assert!(browser_update_ready(&config));
        std::fs::write(&status, "broken").unwrap();
        assert!(!browser_update_ready(&config));
    }
}
