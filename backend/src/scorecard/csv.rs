//! The spreadsheet a scorecard page downloads, read back into dataset rows. The
//! page builds it from the table's rows through its field templates, one column per
//! template; the same templates, read from the page, name the field behind each
//! column. A column whose template formats or combines fields keeps the first
//! field's name and the text as shown.
use crate::{Result, ensure};
use serde_json::{Map, Value};

/// As much text as one spreadsheet may hold.
pub const MAX_TEXT: usize = 16 * 1024 * 1024;
/// Columns a spreadsheet may have.
pub const MAX_COLUMNS: usize = 200;

/// Records of a CSV text: quoted fields, doubled quotes, CRLF or LF, a byte order
/// mark dropped. A record with more fields than the header is refused.
pub fn parse(text: &str) -> Result<Vec<Vec<String>>> {
    ensure(text.len() <= MAX_TEXT, "scorecard_source_too_large", 502)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                other => field.push(other),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => record.push(std::mem::take(&mut field)),
            '\r' => (),
            '\n' => {
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            other => field.push(other),
        }
    }
    ensure(!quoted, "scorecard_csv_invalid", 502)?;
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    // A trailing empty line is not a record.
    records.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    Ok(records)
}

/// The field a column template names: the first `${field}` in it.
pub fn template_field(template: &str) -> Option<&str> {
    let start = template.find("${")? + 2;
    let end = template[start..].find('}')? + start;
    let field = &template[start..end];
    (!field.is_empty()
        && field
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_'))
    .then_some(field)
}
/// Column labels the pages use, for a spreadsheet whose templates could not be read.
const LABELS: &[(&str, &str)] = &[
    ("Week", "data_date"),
    ("Date", "data_date"),
    ("Delivery Associate", "da_name"),
    ("Delivery Associate Name", "da_name"),
    ("Transporter ID", "transporter_id"),
    ("Tracking ID", "tracking_id"),
    ("Event ID", "event_id"),
    ("Delivery Group ID", "delivery_id"),
    ("Impacts Scorecard", "impact"),
    ("DA Selected RTS Code", "rts_reason_code"),
    ("Exemption Reason", "weekly_exemption_reason"),
    ("Additional Information", "weekly_coaching"),
    ("Dispute status", "dispute_status"),
    ("Planned Delivery Date", "delivery_planned_date"),
    ("Service Area", "station_code"),
    ("DSP", "dsp_code"),
    ("Delivery Type", "delivery_type"),
    ("Delivery Date", "delivery_date"),
    ("Concession Date", "concession_date"),
    ("VIN", "vehicle_id"),
    ("Metric Type", "dashboard_metric_type"),
    ("Metric Subtype", "dashboard_metric_subtype"),
    ("Source", "dashboard_source"),
    ("Video Link", "video_url"),
    ("Review Details", "dashboard_review_details"),
    ("Program Impact", "program_impact"),
    ("Date (Station Local Time)", "event_start_time_local"),
    ("Overall Standing", "da_overall_tier"),
    ("Overall Score", "da_overall_score"),
    ("Packages Delivered", "delivered"),
];
/// A field name from a column label: a known label, or the label itself lowered
/// with every run of other characters as one underscore.
pub fn label_field(label: &str) -> String {
    let label = label.trim();
    if let Some((_, field)) = LABELS
        .iter()
        .find(|(known, _)| known.eq_ignore_ascii_case(label))
    {
        return (*field).to_owned();
    }
    let mut out = String::new();
    for c in label.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').to_owned();
    if out.is_empty() { "column".into() } else { out }
}
/// The dataset rows a spreadsheet holds. `templates` are the page's column
/// templates in column order, when they could be read; a column beyond them, or
/// whose template names no field, takes its name from its label.
pub fn rows(text: &str, templates: &[String]) -> Result<Vec<Value>> {
    let mut records = parse(text)?.into_iter();
    let Some(header) = records.next() else {
        return Ok(Vec::new());
    };
    ensure(header.len() <= MAX_COLUMNS, "scorecard_csv_invalid", 502)?;
    let mut fields: Vec<String> = header
        .iter()
        .enumerate()
        .map(|(index, label)| {
            templates
                .get(index)
                .and_then(|template| template_field(template))
                .map(str::to_owned)
                .unwrap_or_else(|| label_field(label))
        })
        .collect();
    // Two columns for one field keep both: the second carries its label.
    for index in 0..fields.len() {
        if fields[..index].contains(&fields[index]) {
            fields[index] = format!("{}_{}", fields[index], label_field(&header[index]));
        }
    }
    records
        .map(|record| {
            ensure(record.len() <= fields.len(), "scorecard_csv_invalid", 502)?;
            let mut row = Map::new();
            for (field, value) in fields.iter().zip(record) {
                row.insert(field.clone(), Value::String(value));
            }
            Ok(Value::Object(row))
        })
        .collect::<Result<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn parsing_handles_quotes_line_endings_and_the_byte_order_mark() {
        let text = "\u{feff}A,B,C\r\n1,\"x, y\",\"say \"\"hi\"\"\"\r\n2,,\n";
        assert_eq!(
            parse(text).unwrap(),
            vec![
                vec!["A", "B", "C"],
                vec!["1", "x, y", "say \"hi\""],
                vec!["2", "", ""]
            ]
        );
        assert!(parse("A,B\n\"open").is_err());
        assert!(parse("").unwrap().is_empty());
    }
    #[test]
    fn columns_take_their_field_from_the_template_then_the_label() {
        assert_eq!(template_field("${da_name}"), Some("da_name"));
        assert_eq!(
            template_field("#ru{${speeding_rate},1}"),
            Some("speeding_rate")
        );
        assert_eq!(
            template_field("#ifv{CASE_${case_id},CASE_,,x}"),
            Some("case_id")
        );
        assert_eq!(template_field("plain"), None);
        assert_eq!(label_field("Transporter ID"), "transporter_id");
        assert_eq!(label_field("Delivery Associate "), "da_name");
        assert_eq!(
            label_field("Sign/ Signal Violations Rate (per trip)"),
            "sign_signal_violations_rate_per_trip"
        );
        let text = "Delivery Associate ,Impacts Scorecard,Tracking ID,Extra\nJo,Y,TBA1,note\n";
        let templates = [
            "${da_name}".to_owned(),
            "${impacting_dcr}".to_owned(),
            "${tracking_id}".to_owned(),
        ];
        assert_eq!(
            rows(text, &templates).unwrap(),
            vec![json!({"da_name":"Jo","impacting_dcr":"Y","tracking_id":"TBA1","extra":"note"})]
        );
        assert_eq!(
            rows("A,A\n1,2\n", &["${x}".to_owned(), "${x}".to_owned()]).unwrap(),
            vec![json!({"x":"1","x_a":"2"})]
        );
        assert!(rows("A\n1,2\n", &[]).is_err());
    }
}
