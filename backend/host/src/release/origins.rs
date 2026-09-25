use crate::{Result, io, require};
use serde::Deserialize;
use std::path::Path;

#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Origins {
    #[serde(rename = "devOrigin", default)]
    pub dev: String,
    #[serde(rename = "productionOrigin", default)]
    pub production: String,
}

impl Origins {
    pub fn load(root: &Path, overrides: Self) -> Result<Self> {
        let file = root.join("config/release.json");
        let mut origins: Self = if file.try_exists()? {
            serde_json::from_value(io::read_json(&file)?)?
        } else {
            Self::default()
        };
        if !overrides.dev.is_empty() {
            origins.dev = overrides.dev;
        }
        if !overrides.production.is_empty() {
            origins.production = overrides.production;
        }
        for value in [&origins.dev, &origins.production] {
            let valid = reqwest::Url::parse(value).is_ok_and(|url| {
                url.scheme() == "https"
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.origin().ascii_serialization() == *value
            });
            require(
                valid,
                "Configure canonical HTTPS Dev and Production origins with --dev-origin/--production-origin or config/release.json",
            )?;
        }
        require(
            origins.dev != origins.production,
            "Dev and Production origins must differ",
        )?;
        Ok(origins)
    }
}
