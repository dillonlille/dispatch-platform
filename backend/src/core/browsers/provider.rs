use crate::core::{Error, Result};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Paycom,
    Cortex,
}
impl Provider {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "paycom" => Ok(Self::Paycom),
            "cortex" => Ok(Self::Cortex),
            _ => Err(Error::new("not_found", 404)),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Paycom => "paycom",
            Self::Cortex => "cortex",
        }
    }
    pub fn key(self, dsp: &str) -> String {
        format!("{dsp}:{}", self.name())
    }
}
