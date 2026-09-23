//! Typed reads. A struct names its columns once in `FromRow`; a column the query did
//! not select, or a value of the wrong type, is an error instead of an empty default.
use crate::{Error, Result};
use rusqlite::types::FromSql;
use serde_json::json;

pub struct Row<'a>(pub(super) &'a rusqlite::Row<'a>);
impl Row<'_> {
    pub fn get<T: FromSql>(&self, column: &str) -> Result<T> {
        self.0.get(column).map_err(|cause| {
            crate::observability::event(
                "error",
                "database.row_invalid",
                json!({"column":column,"cause":cause.to_string()}),
            );
            Error::new("invalid_stored_record", 500)
        })
    }
}
pub trait FromRow: Sized {
    fn from_row(row: &Row<'_>) -> Result<Self>;
}
/// A query that selects one value, such as an id or a name.
impl<T: FromSql> FromRow for (T,) {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok((row.0.get(0)?,))
    }
}

impl<A: FromSql, B: FromSql> FromRow for (A, B) {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok((row.0.get(0)?, row.0.get(1)?))
    }
}
impl<A: FromSql, B: FromSql, C: FromSql> FromRow for (A, B, C) {
    fn from_row(row: &Row<'_>) -> Result<Self> {
        Ok((row.0.get(0)?, row.0.get(1)?, row.0.get(2)?))
    }
}

/// A closed set of strings stored in a column and sent as JSON: one enum with its SQL
/// text, `FromSql`/`ToSql`, and serde, so no caller compares the text.
#[macro_export]
macro_rules! text_enum {
    ($(#[$meta:meta])* $vis:vis enum $name:ident { $($variant:ident => $text:literal,)* }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        $(#[$meta])*
        $vis enum $name { $(#[serde(rename = $text)] $variant,)* }
        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text,)* }
            }
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some(Self::$variant),)* _ => None }
            }
        }
        impl rusqlite::types::FromSql for $name {
            fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
                value.as_str().and_then(|text| Self::parse(text).ok_or(rusqlite::types::FromSqlError::InvalidType))
            }
        }
        impl rusqlite::types::ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }
    };
}
