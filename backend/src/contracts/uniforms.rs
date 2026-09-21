use super::*;

text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum UniformFit { Men => "men", Women => "women", Unisex => "unisex", }
}
text_enum! {
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum UniformEventKind {
        Initialized => "initialized", Created => "created", Updated => "updated",
        Archived => "archived", Adjusted => "adjusted",
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UniformVariant {
    pub id: String,
    pub fit: UniformFit,
    pub size: String,
    pub quantity: u32,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
}
impl FromRow for UniformVariant {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            fit: row.get("fit")?,
            size: row.get("size")?,
            quantity: row.get("quantity")?,
            revision: row.get("revision")?,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Uniform {
    pub id: String,
    pub name: String,
    pub category: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub variants: Vec<UniformVariant>,
}
impl FromRow for Uniform {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            category: row.get("category")?,
            revision: row.get("revision")?,
            variants: vec![],
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UniformInventory {
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub uniforms: Vec<Uniform>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UniformAdjustment {
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub variant_id: String,
    pub quantity: u32,
}
impl FromRow for UniformAdjustment {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            revision: row.get("revision")?,
            variant_id: row.get("variant_id")?,
            quantity: row.get("quantity")?,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UniformUpdates {
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub inventory: Option<UniformInventory>,
    pub adjustments: Vec<UniformAdjustment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UniformEvent {
    #[cfg_attr(test, ts(type = "number"))]
    pub revision: i64,
    pub kind: UniformEventKind,
    pub uniform_name: String,
    pub fit: Option<UniformFit>,
    pub size: Option<String>,
    pub delta: Option<i32>,
    pub quantity: Option<u32>,
    pub actor_name: String,
    pub at: String,
}
impl FromRow for UniformEvent {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok(Self {
            revision: row.get("revision")?,
            kind: row.get("kind")?,
            uniform_name: row.get("uniform_name")?,
            fit: row.get("fit")?,
            size: row.get("size")?,
            delta: row.get("delta")?,
            quantity: row.get("quantity")?,
            actor_name: row.get("actor_name")?,
            at: row.get("at")?,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UniformHistory {
    pub events: Vec<UniformEvent>,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub next_before: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UniformVariantInput {
    pub id: Option<String>,
    pub fit: UniformFit,
    pub size: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UniformInput {
    pub name: String,
    pub category: String,
    pub revision: Option<i64>,
    pub variants: Vec<UniformVariantInput>,
}
impl UniformInput {
    pub fn parse(value: &Value) -> Result<Self> {
        let mut input: Self = request(value)?;
        input.name = v::name(value, "name", 80)?;
        input.category = v::name(value, "category", 40)?;
        ensure(input.variants.len() <= 150, "uniform_size_limit", 400)?;
        let mut sizes = std::collections::HashSet::new();
        let mut ids = std::collections::HashSet::new();
        for variant in &mut input.variants {
            variant.size = variant.size.trim().to_owned();
            ensure(
                (1..=24).contains(&variant.size.chars().count()),
                "invalid_uniform_size",
                400,
            )?;
            ensure(
                sizes.insert((variant.fit, variant.size.to_lowercase())),
                "uniform_size_duplicate",
                400,
            )?;
            if let Some(id) = &variant.id {
                ensure(ids.insert(id), "invalid_input", 400)?;
            }
        }
        Ok(input)
    }
}
