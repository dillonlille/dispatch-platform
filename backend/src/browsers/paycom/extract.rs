//! A Paycom timecard response read in this process. It follows `timecard.js` on a
//! detached document: the same fields, the same validation and no layout. Parsing
//! matches `DOMParser` with scripting off, so no provider script runs. Anything a
//! browser would read differently fails closed; each job still proves these records
//! equal rendered ones before relying on them.
use chrono::{Datelike, NaiveDate};
use ego_tree::NodeRef;
use html5ever::{
    ParseOpts, QualName, local_name, ns,
    tendril::TendrilSink,
    tree_builder::{QuirksMode, TreeBuilderOpts},
};
use scraper::{ElementRef, Html, HtmlTreeSink, Node};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

/// Why a response was not read.
#[derive(Debug, PartialEq)]
pub(super) enum Unreadable {
    /// The page names another employee: a rendered read would refuse it too.
    WrongEmployee,
    /// One of `timecard.js`'s validation codes, or a form this reader does not know.
    Invalid(&'static str),
}
type Read<T> = std::result::Result<T, Unreadable>;
fn invalid<T>(code: &'static str) -> Read<T> {
    Err(Unreadable::Invalid(code))
}

/// The timecard a response should hold.
pub(super) struct Source<'a> {
    pub employee: &'a str,
    pub period: &'a Value,
    pub url: &'a str,
}

const HEADERS: &[&str] = &[
    "date",
    "paycode",
    "i1",
    "allocation1",
    "o1",
    "i2",
    "allocation2",
    "o2",
    "hours",
    "total_hours",
    "amount",
    "exception-points",
    "waiver",
    "comment",
    "missing-punch",
    "delete",
];
const SLOTS: [&str; 4] = ["i1", "o1", "i2", "o2"];
const KINDS: [&str; 4] = ["IN DAY", "OUT LUNCH", "IN LUNCH", "OUT DAY"];
const LABELS: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    change_operation: Option<&'static str>,
    current_kind: Option<&'static str>,
    current_time: Option<String>,
    requested_kind: Option<&'static str>,
    requested_time: Option<String>,
    change_note: Option<String>,
    change_detail_state: &'static str,
}
impl Change {
    fn empty(state: &'static str) -> Self {
        Self {
            change_operation: None,
            current_kind: None,
            current_time: None,
            requested_kind: None,
            requested_time: None,
            change_note: None,
            change_detail_state: state,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Punch {
    ordinal: usize,
    row_index: usize,
    slot: &'static str,
    kind: String,
    display_time: String,
    actual_time: String,
    rounded_time: String,
    clock_name: String,
    clock_code: String,
    comment: String,
    provenance_available: bool,
    change_request_status: Option<&'static str>,
    approved: bool,
    #[serde(flatten)]
    change: Change,
}
/// What one table row holds, before it is placed as a day or an additional row.
struct Row {
    pay_code: String,
    allocation1: String,
    allocation2: String,
    hours: Option<f64>,
    total_hours: Option<f64>,
    dollars: Option<f64>,
    exception_text: String,
    waiver_checked: Option<bool>,
    comments: Vec<String>,
    unresolved_slots: Vec<&'static str>,
    punches: Vec<Punch>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Day {
    date: String,
    label: String,
    pay_code: String,
    allocation1: String,
    allocation2: String,
    hours: Option<f64>,
    total_hours: Option<f64>,
    dollars: Option<f64>,
    exception_text: String,
    waiver_checked: Option<bool>,
    comments: Vec<String>,
    missing_punch: bool,
    unresolved_slots: Vec<String>,
    punches: Vec<Punch>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdditionalRow {
    date: String,
    row_index: usize,
    row_class: String,
    pay_code: String,
    allocation1: String,
    allocation2: String,
    hours: Option<f64>,
    total_hours: Option<f64>,
    dollars: Option<f64>,
    exception_text: String,
    waiver_checked: Option<bool>,
    comments: Vec<String>,
    unresolved_slots: Vec<&'static str>,
    punch_ordinals: Vec<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u8,
    source_format: &'static str,
    employee_code: String,
    period_start: String,
    period_end: String,
    period_key: String,
    source_url: String,
    page_title: String,
    headers: Vec<String>,
    days: Vec<Day>,
    additional_rows: Vec<AdditionalRow>,
    weekly_totals: Vec<Option<f64>>,
    period_total_hours: Option<f64>,
    approvals: Vec<Vec<String>>,
    attestations: Vec<Vec<String>>,
    meal_waivers: Vec<Vec<String>>,
}

/// The record `timecard.js` returns for this response, validated the same way.
pub(super) fn timecard(html: &str, source: &Source) -> Read<Value> {
    let options = ParseOpts {
        tree_builder: TreeBuilderOpts {
            scripting_enabled: false,
            ..Default::default()
        },
        ..Default::default()
    };
    let document =
        html5ever::parse_document(HtmlTreeSink::new(Html::new_document()), options).one(html);
    let page = Page {
        document: &document,
        quirks: document.quirks_mode == QuirksMode::Quirks,
    };
    let record = page.record(source)?;
    validate(&record, source)?;
    serde_json::to_value(record).map_err(|_| Unreadable::Invalid("timecard_identity_invalid"))
}

// JavaScript's `\s` and `trim`.
fn space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn trim(value: &str) -> &str {
    value.trim_matches(space)
}
/// `String(value).replace(/\s+/g, ' ').trim()`.
fn clean(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut gap = false;
    for c in value.chars() {
        if space(c) {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    out
}
/// A JavaScript string's `length`.
fn units(value: &str) -> usize {
    value.encode_utf16().count()
}
/// `value.slice(start)` in UTF-16 units.
fn slice_from(value: &str, start: usize) -> &str {
    let mut count = 0;
    for (index, c) in value.char_indices() {
        if count >= start {
            return &value[index..];
        }
        count += c.len_utf16();
    }
    ""
}
fn bounded(value: &str, max: usize) -> bool {
    units(value) <= max
        && !value.chars().any(
            |c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'),
        )
}
/// `/^(0[1-9]|1[0-2]):[0-5][0-9] [AP]M$/`.
fn time(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 8
        && matches!((b[0], b[1]), (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2'))
        && b[2] == b':'
        && (b'0'..=b'5').contains(&b[3])
        && b[4].is_ascii_digit()
        && b[5] == b' '
        && matches!(b[6], b'A' | b'P')
        && b[7] == b'M'
}
/// `/^(0?[1-9]|1[0-2]):([0-5][0-9]) ([AP])M$/`, as the zero-padded time it shows.
fn shown_time(value: &str) -> Option<String> {
    let (hour, rest) = value.split_once(':')?;
    let hour = match hour.as_bytes() {
        [h @ b'1'..=b'9'] => format!("0{}", *h as char),
        [b'0', b'1'..=b'9'] | [b'1', b'0'..=b'2'] => hour.to_owned(),
        _ => return None,
    };
    let r = rest.as_bytes();
    (r.len() == 5
        && (b'0'..=b'5').contains(&r[0])
        && r[1].is_ascii_digit()
        && r[2] == b' '
        && matches!(r[3], b'A' | b'P')
        && r[4] == b'M')
        .then(|| format!("{hour}:{rest}"))
}
/// `Number(text)` for the text of a cell.
fn number(value: &str) -> Option<f64> {
    let text = trim(value);
    if text.is_empty() {
        return Some(0.);
    }
    match text {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|p| text.strip_prefix(p)) {
            return (!digits.is_empty() && digits.len() <= 32)
                .then(|| u128::from_str_radix(digits, radix).ok())
                .flatten()
                .map(|n| n as f64);
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let valid = digits(whole)
        && digits(fraction)
        && (!whole.is_empty() || !fraction.is_empty())
        && exponent.is_none_or(|e| {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            !e.is_empty() && digits(e)
        });
    valid.then(|| text.parse().ok()).flatten()
}
/// A cell's amount: `$` and `,` removed, finite and not negative.
fn numeric(value: &str) -> Option<f64> {
    let text = clean(value);
    if text.is_empty() {
        return None;
    }
    number(&text.replace(['$', ','], "")).filter(|n| n.is_finite() && *n >= 0.)
}
/// `Number(value.toFixed(2))` for a finite, non-negative value.
fn fixed(value: f64) -> f64 {
    if value >= 1e21 {
        return value;
    }
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i64;
    let fraction = u128::from(bits & ((1 << 52) - 1));
    let (mantissa, exponent) = if exponent == 0 {
        (fraction, -1074)
    } else {
        (fraction | 1 << 52, exponent - 1075)
    };
    let scaled = mantissa * 100;
    // The nearest hundredth; an exact tie goes to the larger one, as `toFixed` does.
    let hundredths = if exponent >= 0 {
        scaled << exponent as u32
    } else if -exponent > 100 {
        0
    } else {
        let shift = (-exponent) as u32;
        (scaled + (1u128 << (shift - 1))) >> shift
    };
    format!("{}.{:02}", hundredths / 100, hundredths % 100)
        .parse()
        .unwrap_or(f64::NAN)
}
/// `/<br\s*\/?>/gi` replaced with a newline.
fn line_breaks(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        let matched = tail
            .get(..2)
            .filter(|name| name.eq_ignore_ascii_case("br"))
            .and_then(|_| {
                let after = tail[2..].trim_start_matches(space);
                let after = after.strip_prefix('/').unwrap_or(after);
                after.strip_prefix('>')
            });
        match matched {
            Some(after) => {
                out.push('\n');
                rest = after;
            }
            None => {
                out.push('<');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}
/// A `<div>`'s `textContent` after `innerHTML = value`.
fn markup_text(value: &str) -> String {
    if !value.contains(['<', '&', '\r', '\0']) {
        return value.to_owned();
    }
    let options = ParseOpts {
        tree_builder: TreeBuilderOpts {
            scripting_enabled: false,
            ..Default::default()
        },
        ..Default::default()
    };
    let fragment = html5ever::parse_fragment(
        HtmlTreeSink::new(Html::new_fragment()),
        options,
        QualName::new(None, ns!(html), local_name!("div")),
        Vec::new(),
        false,
    )
    .one(value);
    text(fragment.tree.root(), true)
}
/// `timecard.js`'s `decode`: an attribute that holds markup, as the text it shows.
fn decode(value: &str) -> String {
    let mut out = value.to_owned();
    for _ in 0..2 {
        out = markup_text(&line_breaks(&out));
    }
    let out = out.replace('\u{a0}', " ");
    let mut collapsed = String::with_capacity(out.len());
    let mut gap = false;
    for c in out.chars() {
        if c == ' ' || c == '\t' {
            gap = true;
        } else {
            if gap {
                collapsed.push(' ');
            }
            gap = false;
            collapsed.push(c);
        }
    }
    if gap {
        collapsed.push(' ');
    }
    trim(&collapsed).to_owned()
}

/// Nodes below `root` in tree order, as a selector sees them: never inside a
/// template's contents.
fn descendants<'a>(root: NodeRef<'a, Node>) -> impl Iterator<Item = NodeRef<'a, Node>> {
    let mut stack: Vec<_> = root.children().rev().collect();
    std::iter::from_fn(move || {
        let node = stack.pop()?;
        if !matches!(node.value(), Node::Fragment) {
            stack.extend(node.children().rev());
        }
        Some(node)
    })
}
fn elements<'a>(root: NodeRef<'a, Node>) -> impl Iterator<Item = ElementRef<'a>> {
    descendants(root).filter_map(ElementRef::wrap)
}
/// `textContent`, or with `code` false the text `visible` keeps: no script or style.
fn text(root: NodeRef<'_, Node>, code: bool) -> String {
    let mut out = String::new();
    let mut stack: Vec<_> = root.children().rev().collect();
    while let Some(node) = stack.pop() {
        match node.value() {
            Node::Text(value) => out.push_str(value),
            Node::Element(element) if !code && matches!(element.name(), "script" | "style") => {}
            Node::Element(_) => stack.extend(node.children().rev()),
            _ => {}
        }
    }
    out
}
fn visible(element: Option<ElementRef<'_>>) -> String {
    element.map(|e| clean(&text(*e, false))).unwrap_or_default()
}
fn is(element: ElementRef<'_>, name: &str) -> bool {
    element.value().name() == name
}
fn html(element: ElementRef<'_>, name: &str) -> bool {
    is(element, name) && element.value().name.ns == ns!(html)
}
fn attr<'a>(element: ElementRef<'a>, name: &str) -> Option<&'a str> {
    element.value().attr(name)
}
/// An option's `text`: whitespace stripped and collapsed, scripts left out.
fn option_text(option: ElementRef<'_>) -> String {
    let mut out = String::new();
    let mut stack: Vec<_> = option.children().rev().collect();
    while let Some(node) = stack.pop() {
        match node.value() {
            Node::Text(value) => out.push_str(value),
            Node::Element(element) if element.name() == "script" => {}
            Node::Element(_) => stack.extend(node.children().rev()),
            _ => {}
        }
    }
    out.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
}
fn option_value(option: ElementRef<'_>) -> String {
    attr(option, "value").map_or_else(|| option_text(option), str::to_owned)
}
/// The option a parsed `<select>` has selected, and its `value`.
fn selected(select: ElementRef<'_>) -> Option<ElementRef<'_>> {
    let mut options = Vec::new();
    for child in select.child_elements() {
        if html(child, "option") {
            options.push((child, attr(child, "disabled").is_some()));
        } else if html(child, "optgroup") {
            let disabled = attr(child, "disabled").is_some();
            for option in child.child_elements().filter(|e| html(*e, "option")) {
                options.push((option, disabled || attr(option, "disabled").is_some()));
            }
        }
    }
    let marked = || {
        options
            .iter()
            .filter(|(o, _)| attr(*o, "selected").is_some())
    };
    if attr(select, "multiple").is_some() {
        return marked().next().map(|(o, _)| *o);
    }
    // The rules for parsing non-negative integers: leading digits, the rest ignored.
    let size = attr(select, "size")
        .map(|v| v.trim_start_matches(|c: char| c.is_ascii_whitespace()))
        .map(|v| v.strip_prefix('+').unwrap_or(v))
        .map(|v| v.bytes().take_while(u8::is_ascii_digit).collect::<Vec<_>>())
        .filter(|digits| !digits.is_empty())
        .and_then(|digits| String::from_utf8(digits).ok()?.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1);
    marked().next_back().map(|(o, _)| *o).or_else(|| {
        (size == 1)
            .then(|| {
                options
                    .iter()
                    .find(|(_, disabled)| !disabled)
                    .map(|(o, _)| *o)
            })
            .flatten()
    })
}
fn select_value(select: ElementRef<'_>) -> String {
    selected(select).map(option_value).unwrap_or_default()
}
/// An `<input>`'s `value` before anyone edits it.
fn input_value(input: ElementRef<'_>) -> Read<String> {
    let value = attr(input, "value");
    let kind = attr(input, "type").unwrap_or("").to_ascii_lowercase();
    let lines = |v: Option<&str>| v.unwrap_or("").replace(['\r', '\n'], "");
    Ok(match kind.as_str() {
        "checkbox" | "radio" => value.unwrap_or("on").to_owned(),
        "hidden" | "submit" | "image" | "reset" | "button" => value.unwrap_or("").to_owned(),
        "file" => String::new(),
        "url" => lines(value).trim_ascii().to_owned(),
        "email" if attr(input, "multiple").is_none() => lines(value).trim_ascii().to_owned(),
        // Each sanitizes its value by rules this reader does not repeat.
        "email" | "number" | "range" | "color" | "date" | "month" | "week" | "time"
        | "datetime-local" => return invalid("timecard_control_unsupported"),
        _ => lines(value),
    })
}
fn textarea_value(textarea: ElementRef<'_>) -> String {
    textarea
        .children()
        .filter_map(|node| node.value().as_text().map(|t| t.to_string()))
        .collect()
}
/// `element.value`, where an element has one.
fn value_property(element: ElementRef<'_>) -> Read<Option<String>> {
    if element.value().name.ns != ns!(html) {
        return Ok(None);
    }
    Ok(Some(match element.value().name() {
        "input" => input_value(element)?,
        "textarea" => textarea_value(element),
        "select" => select_value(element),
        "option" => option_value(element),
        "button" | "data" | "param" => attr(element, "value").unwrap_or("").to_owned(),
        "output" => text(*element, true),
        "li" | "meter" | "progress" => return invalid("timecard_control_unsupported"),
        _ => return Ok(None),
    }))
}
/// `/^Comment:\s*/i` removed.
fn comment(value: &str) -> &str {
    match value.get(..8) {
        Some(prefix) if prefix.eq_ignore_ascii_case("comment:") => {
            value[8..].trim_start_matches(space)
        }
        _ => value,
    }
}
/// A day's heading, such as `SUN (09/13)`: its label and date.
fn day_header(value: &str) -> Option<(String, String)> {
    let text = clean(value);
    let b = text.as_bytes();
    if b.len() < 3 || !b[..3].iter().all(u8::is_ascii_uppercase) {
        return None;
    }
    let rest = &text[3..];
    let rest = rest.strip_prefix(' ').unwrap_or(rest);
    let r = rest.as_bytes();
    (r.len() == 7
        && r[0] == b'('
        && r[1..3].iter().all(u8::is_ascii_digit)
        && r[3] == b'/'
        && r[4..6].iter().all(u8::is_ascii_digit)
        && r[6] == b')')
        .then(|| (text[..3].to_owned(), rest[1..6].to_owned()))
}
fn weekly(row: ElementRef<'_>) -> bool {
    row.child_elements()
        .next()
        .is_some_and(|cell| clean(&text(*cell, true)).eq_ignore_ascii_case("Weekly Totals"))
}
/// `/^(IN DAY|OUT LUNCH|IN LUNCH|OUT DAY|OUT BREAK|IN BREAK)\b/i`, in its canonical kind.
fn punch_kind(line: &str) -> String {
    for name in [
        "IN DAY",
        "OUT LUNCH",
        "IN LUNCH",
        "OUT DAY",
        "OUT BREAK",
        "IN BREAK",
    ] {
        let bytes = line.as_bytes();
        if bytes.len() >= name.len()
            && bytes[..name.len()].eq_ignore_ascii_case(name.as_bytes())
            && bytes
                .get(name.len())
                .is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'_'))
        {
            return match name {
                "OUT BREAK" => "OUT LUNCH",
                "IN BREAK" => "IN LUNCH",
                other => other,
            }
            .to_owned();
        }
    }
    String::new()
}
/// A clock such as `Front Door (12)`: its name and code.
fn clock(value: &str) -> (String, String) {
    let whole = value.trim_end_matches(space);
    if let Some(inner) = whole.strip_suffix(')')
        && let Some(open) = inner.rfind('(')
        && !inner[open + 1..].contains(')')
    {
        return (clean(&inner[..open]), clean(&inner[open + 1..]));
    }
    (value.to_owned(), String::new())
}

/// The direction of a pending or decided punch change, as `normalizeRequestDetail`.
#[derive(Default)]
struct Observed {
    operation: Vec<String>,
    current_kind: Vec<String>,
    current_time: Vec<String>,
    requested_kind: Vec<String>,
    requested_time: Vec<String>,
    note: Vec<String>,
}
impl Observed {
    fn field(&mut self, key: usize) -> &mut Vec<String> {
        match key {
            0 => &mut self.operation,
            1 => &mut self.current_kind,
            2 => &mut self.current_time,
            3 => &mut self.requested_kind,
            4 => &mut self.requested_time,
            _ => &mut self.note,
        }
    }
    fn normalize(self) -> Read<Change> {
        let fields = [
            &self.operation,
            &self.current_kind,
            &self.current_time,
            &self.requested_kind,
            &self.requested_time,
            &self.note,
        ];
        if fields.iter().all(|values| values.is_empty()) {
            return Ok(Change::empty("unavailable"));
        }
        if fields[..5].iter().any(|values| values.len() != 1) || self.note.len() > 1 {
            return invalid("timecard_provenance_invalid");
        }
        if fields[..5].iter().any(|values| units(&values[0]) > 200) {
            return invalid("timecard_provenance_invalid");
        }
        let operation = match self.operation[0].to_lowercase().as_str() {
            "add" => "add",
            "edit" => "edit",
            "delete" => "delete",
            "type_change" | "type change" => "type_change",
            _ => return invalid("timecard_provenance_invalid"),
        };
        let kind = |value: &str| -> Read<Option<&'static str>> {
            if value.is_empty() {
                return Ok(None);
            }
            match value.to_uppercase().as_str() {
                "IN DAY" => Ok(Some("IN DAY")),
                "OUT LUNCH" | "OUT BREAK" => Ok(Some("OUT LUNCH")),
                "IN LUNCH" | "IN BREAK" => Ok(Some("IN LUNCH")),
                "OUT DAY" => Ok(Some("OUT DAY")),
                _ => invalid("timecard_provenance_invalid"),
            }
        };
        let at = |value: &str| -> Read<Option<String>> {
            if value.is_empty() {
                return Ok(None);
            }
            let upper = value.to_uppercase();
            if time(&upper) {
                Ok(Some(upper))
            } else {
                invalid("timecard_provenance_invalid")
            }
        };
        let current_kind = kind(&self.current_kind[0])?;
        let requested_kind = kind(&self.requested_kind[0])?;
        let current_time = at(&self.current_time[0])?;
        let requested_time = at(&self.requested_time[0])?;
        let note = self.note.first().cloned();
        if note.as_ref().is_some_and(|note| {
            units(note) > 2000 || note.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        }) {
            return invalid("timecard_provenance_invalid");
        }
        let current = current_kind.is_some() && current_time.is_some();
        let requested = requested_kind.is_some() && requested_time.is_some();
        let complete = match operation {
            "add" => current_kind.is_none() && current_time.is_none() && requested,
            "delete" => current && requested_kind.is_none() && requested_time.is_none(),
            "edit" => {
                current && current_kind == requested_kind && current_time.is_some() && requested
            }
            _ => current && requested && current_kind != requested_kind,
        };
        if !complete {
            return invalid("timecard_provenance_invalid");
        }
        Ok(Change {
            change_operation: Some(operation),
            current_kind,
            current_time,
            requested_kind,
            requested_time,
            change_note: note,
            change_detail_state: "complete",
        })
    }
}

struct Page<'a> {
    document: &'a Html,
    quirks: bool,
}
impl<'a> Page<'a> {
    /// Class and id selectors ignore case only in a quirks-mode document.
    fn same(&self, value: &str, expected: &str) -> bool {
        if self.quirks {
            value.eq_ignore_ascii_case(expected)
        } else {
            value == expected
        }
    }
    fn has_class(&self, element: ElementRef<'_>, name: &str) -> bool {
        attr(element, "class")
            .is_some_and(|v| v.split_ascii_whitespace().any(|c| self.same(c, name)))
    }
    fn has_id(&self, element: ElementRef<'_>, id: &str) -> bool {
        attr(element, "id").is_some_and(|v| self.same(v, id))
    }
    fn all(&self) -> impl Iterator<Item = ElementRef<'a>> {
        elements(self.document.tree.root())
    }
    fn by_id(&self, id: &str) -> Option<ElementRef<'a>> {
        self.all().find(|e| self.has_id(*e, id))
    }
    /// `closest('.readOnly-combined-cell,[hidden]')`: the element or an ancestor.
    fn hidden(&self, element: ElementRef<'_>) -> bool {
        std::iter::once(*element)
            .chain(element.ancestors())
            .filter_map(ElementRef::wrap)
            .any(|e| self.has_class(e, "readOnly-combined-cell") || attr(e, "hidden").is_some())
    }
    /// The time a punch cell shows: Paycom marks it with a class, beside a hidden copy.
    fn punch_time(&self, element: Option<ElementRef<'_>>) -> Read<String> {
        let Some(element) = element else {
            return Ok(String::new());
        };
        let values = element
            .child_elements()
            .filter(|child| {
                is(*child, "span")
                    && self.has_class(*child, "current-timecard-cell")
                    && !self.hidden(*child)
            })
            .filter_map(|child| shown_time(&clean(&text(*child, true))))
            .collect::<Vec<_>>();
        match <[String; 1]>::try_from(values) {
            Ok([value]) => Ok(value),
            Err(_) => self.control_value(Some(element)),
        }
    }
    fn control_value(&self, element: Option<ElementRef<'_>>) -> Read<String> {
        let Some(element) = element else {
            return Ok(String::new());
        };
        if let Some(select) = elements(*element).find(|e| is(*e, "select")) {
            if select.value().name.ns != ns!(html) {
                return Ok(String::new());
            }
            let value = select_value(select);
            return Ok(clean(&if value.is_empty() {
                selected(select).map(|o| text(*o, true)).unwrap_or_default()
            } else {
                value
            }));
        }
        if let Some(input) = elements(*element).find(|e| is(*e, "input") || is(*e, "textarea")) {
            if input.value().name.ns != ns!(html) {
                return Ok(String::new());
            }
            return Ok(clean(&if is(input, "input") {
                input_value(input)?
            } else {
                textarea_value(input)
            }));
        }
        let triggers = elements(*element)
            .filter(|e| {
                is(*e, "a")
                    && self.has_class(*e, "popoverTrigger")
                    && self.has_class(*e, "popoverTrigger--text")
                    && !self.hidden(*e)
            })
            .collect::<Vec<_>>();
        Ok(match triggers.as_slice() {
            [trigger] => clean(&text(**trigger, true)),
            _ => visible(Some(element)),
        })
    }
    fn change(&self, nodes: &[ElementRef<'_>], status: Option<&'static str>) -> Read<Change> {
        if status.is_none() {
            return Ok(Change::empty("not_applicable"));
        }
        const ATTRIBUTES: [&[&str]; 6] = [
            &["data-pcr-operation", "data-change-operation"],
            &["data-pcr-current-kind", "data-pcr-current-type"],
            &["data-pcr-current-time"],
            &["data-pcr-requested-kind", "data-pcr-requested-type"],
            &["data-pcr-requested-time"],
            &["data-pcr-note", "data-change-note"],
        ];
        const LABELS: [&[&str]; 6] = [
            &["Operation", "Request Operation"],
            &["Current Kind", "Current Type"],
            &["Current Time"],
            &["Requested Kind", "Requested Type"],
            &["Requested Time"],
            &["Request Note", "Change Note"],
        ];
        let mut observed = Observed::default();
        for node in nodes {
            for (key, aliases) in ATTRIBUTES.iter().enumerate() {
                for alias in *aliases {
                    if let Some(value) = attr(*node, alias) {
                        observed.field(key).push(clean(value));
                    }
                }
            }
            for name in ["title", "data-content", "data-original-title"] {
                let Some(raw) = attr(*node, name) else {
                    continue;
                };
                if units(raw) > 4000 {
                    return invalid("timecard_provenance_invalid");
                }
                let content = decode(raw);
                if units(&content) > 4000 {
                    return invalid("timecard_provenance_invalid");
                }
                for line in content.split('\n').map(clean).filter(|l| !l.is_empty()) {
                    for (key, aliases) in LABELS.iter().enumerate() {
                        for alias in *aliases {
                            if let Some(value) = line
                                .strip_prefix(alias)
                                .and_then(|rest| rest.strip_prefix(':'))
                            {
                                observed.field(key).push(clean(value));
                            }
                        }
                    }
                }
            }
        }
        observed.normalize()
    }
    fn punch(
        &self,
        element: Option<ElementRef<'_>>,
        slot: &'static str,
        row_index: usize,
    ) -> Read<Option<Punch>> {
        let display_time = self.punch_time(element)?;
        let Some(element) = element.filter(|_| !display_time.is_empty() && display_time != "??")
        else {
            return Ok(None);
        };
        let nodes = std::iter::once(element)
            .chain(elements(*element))
            .collect::<Vec<_>>();
        if nodes.len() > 128 {
            return invalid("timecard_pcr_marker_invalid");
        }
        let mut markers = Vec::new();
        for node in &nodes {
            let mut seen = HashSet::new();
            for token in attr(*node, "class").unwrap_or("").split_ascii_whitespace() {
                if !seen.insert(token) {
                    continue;
                }
                if token
                    .get(..3)
                    .is_some_and(|p| p.eq_ignore_ascii_case("pcr"))
                {
                    if units(token) > 100 {
                        return invalid("timecard_pcr_marker_invalid");
                    }
                    markers.push(token);
                }
                if markers.len() > 256 {
                    return invalid("timecard_pcr_marker_invalid");
                }
            }
        }
        let status = match markers.as_slice() {
            [] => None,
            ["pcrApproved"] => Some("approved"),
            ["pcrPending"] => Some("pending"),
            ["pcrRejected"] => Some("rejected"),
            _ => return invalid("timecard_pcr_marker_invalid"),
        };
        let change = self.change(&nodes, status)?;
        let provenance = elements(*element)
            .find(|e| attr(*e, "title").is_some_and(|t| t.contains("Actual:")))
            .and_then(|e| attr(e, "title"))
            .filter(|raw| !raw.is_empty());
        let mut punch = Punch {
            ordinal: 0,
            row_index,
            slot,
            kind: String::new(),
            display_time,
            actual_time: String::new(),
            rounded_time: String::new(),
            clock_name: String::new(),
            clock_code: String::new(),
            comment: String::new(),
            provenance_available: false,
            change_request_status: status,
            approved: status == Some("approved"),
            change,
        };
        let Some(raw) = provenance else {
            return Ok(Some(punch));
        };
        let decoded = decode(raw);
        let lines = decoded
            .split('\n')
            .map(clean)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>();
        let field = |name: &str| {
            let prefix = format!("{}:", name.to_lowercase());
            lines
                .iter()
                .find(|line| line.to_lowercase().starts_with(&prefix))
                .map(|line| clean(slice_from(line, units(name) + 1)))
                .unwrap_or_default()
        };
        punch.kind = punch_kind(lines.first().map_or("", String::as_str));
        (punch.clock_name, punch.clock_code) = clock(&field("Clock"));
        punch.actual_time = field("Actual");
        punch.rounded_time = field("Rounded");
        punch.comment = field("Comment");
        punch.provenance_available = true;
        Ok(Some(punch))
    }
    fn row(&self, row: ElementRef<'_>, headers: &[String], row_index: usize) -> Read<Row> {
        let cells = row.child_elements().collect::<Vec<_>>();
        let cell = |name: &str| {
            headers
                .iter()
                .position(|h| h == name)
                .and_then(|i| cells.get(i).copied())
        };
        let mut unresolved = Vec::new();
        let mut punches = Vec::new();
        for slot in SLOTS {
            let element = cell(slot);
            if element.is_some_and(|e| clean(&text(*e, true)) == "??") {
                unresolved.push(slot);
            }
            if let Some(punch) = self.punch(element, slot, row_index)? {
                punches.push(punch);
            }
        }
        let waiver = cell("waiver").and_then(|c| {
            elements(*c).find(|e| {
                is(*e, "input")
                    && attr(*e, "type").is_some_and(|t| t.eq_ignore_ascii_case("checkbox"))
            })
        });
        let comments = cell("comment")
            .map(|c| {
                elements(*c)
                    .filter_map(|e| attr(e, "title"))
                    .map(|title| trim(comment(&decode(title))).to_owned())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Ok(Row {
            pay_code: self.control_value(cell("paycode"))?,
            allocation1: visible(cell("allocation1")),
            allocation2: visible(cell("allocation2")),
            hours: numeric(&visible(cell("hours"))),
            total_hours: numeric(&visible(cell("total_hours"))),
            dollars: numeric(&visible(cell("amount"))),
            exception_text: visible(cell("exception-points")),
            waiver_checked: waiver
                .map(|w| w.value().name.ns == ns!(html) && attr(w, "checked").is_some()),
            comments,
            unresolved_slots: unresolved,
            punches,
        })
    }
    /// `tbody` children of `table`, and their `tr` children.
    fn rows(table: ElementRef<'a>) -> impl Iterator<Item = ElementRef<'a>> {
        table
            .child_elements()
            .filter(|e| is(*e, "tbody"))
            .flat_map(|body| body.child_elements().filter(|e| is(*e, "tr")))
    }
    fn generic(&self, id: &str) -> Vec<Vec<String>> {
        let Some(found) = self.by_id(id) else {
            return Vec::new();
        };
        Self::rows(found)
            .map(|row| {
                row.child_elements()
                    .map(|c| visible(Some(c)))
                    .collect::<Vec<_>>()
            })
            .filter(|row| {
                row.iter().any(|v| !v.is_empty())
                    && !row.join(" ").eq_ignore_ascii_case("No Records Found")
            })
            .collect()
    }
    fn employee(&self) -> Read<String> {
        let mut values = Vec::new();
        for element in self.all() {
            let named = is(element, "input")
                && (attr(element, "name") == Some("firstrefno")
                    || self.has_id(element, "firstrefno"));
            let first = attr(element, "data-firstrefno");
            let code = attr(element, "data-employee-code");
            if !(named || first.is_some() || code.is_some()) {
                continue;
            }
            let value = value_property(element)?;
            let chosen = [value.as_deref(), first, code]
                .into_iter()
                .flatten()
                .find(|v| !v.is_empty())
                .unwrap_or("");
            let value = clean(chosen);
            if !value.is_empty() {
                values.push(value);
            }
        }
        if values.is_empty()
            || values
                .iter()
                .any(|v| v.len() != 4 || !v.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            return Ok(String::new());
        }
        let codes = values
            .iter()
            .map(|v| v.to_ascii_uppercase())
            .collect::<HashSet<_>>();
        Ok(if codes.len() == 1 {
            codes.into_iter().next().unwrap_or_default()
        } else {
            String::new()
        })
    }
    /// `document.title`: the first `<title>`'s own text, whitespace collapsed.
    fn title(&self) -> String {
        self.all()
            .find(|e| html(*e, "title"))
            .map(|title| {
                textarea_value(title)
                    .split_ascii_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    }
    fn record(&self, source: &Source) -> Read<Record> {
        let table = self
            .by_id("tbltimesheet")
            .ok_or(Unreadable::Invalid("timecard_identity_invalid"))?;
        let headers = elements(*table)
            .filter(|e| {
                attr(*e, "data-column").is_some()
                    && e.ancestors()
                        .filter_map(ElementRef::wrap)
                        .any(|a| is(a, "thead"))
            })
            .map(|e| attr(e, "data-column").unwrap_or("").to_owned())
            .collect::<Vec<_>>();
        let dates = source.period["dates"].as_array();
        let rows = Self::rows(table).collect::<Vec<_>>();
        let first = |row: &ElementRef<'_>| {
            row.child_elements()
                .next()
                .map(|cell| text(*cell, true))
                .unwrap_or_default()
        };
        let mut days = Vec::new();
        let mut additional = Vec::new();
        let mut next = [1usize; 14];
        for row in &rows {
            let heading = first(row);
            if let Some((label, date_text)) = day_header(&heading) {
                let projected = self.row(*row, &headers, 0)?;
                let expected = dates
                    .and_then(|d| d.get(days.len()))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let mut punches = projected.punches;
                for (index, punch) in punches.iter_mut().enumerate() {
                    punch.ordinal = index + 1;
                }
                days.push(Day {
                    date: if expected.get(5..).map(|md| md.replacen('-', "/", 1)) == Some(date_text)
                    {
                        expected.to_owned()
                    } else {
                        String::new()
                    },
                    label,
                    pay_code: projected.pay_code,
                    allocation1: projected.allocation1,
                    allocation2: projected.allocation2,
                    hours: projected.hours,
                    total_hours: projected.total_hours,
                    dollars: projected.dollars,
                    exception_text: projected.exception_text,
                    waiver_checked: projected.waiver_checked,
                    comments: projected.comments,
                    missing_punch: !projected.unresolved_slots.is_empty(),
                    unresolved_slots: projected
                        .unresolved_slots
                        .iter()
                        .map(|s| (*s).to_owned())
                        .collect(),
                    punches,
                });
                continue;
            }
            if weekly(*row)
                || days.is_empty()
                || row.child_elements().count() != headers.len()
                || !clean(&heading).is_empty()
            {
                continue;
            }
            let day_index = days.len() - 1;
            let Some(slot) = next.get_mut(day_index) else {
                return invalid("timecard_day_count_invalid");
            };
            let row_index = *slot;
            *slot += 1;
            let projected = self.row(*row, &headers, row_index)?;
            let day = &mut days[day_index];
            let start = day.punches.len();
            let mut ordinals = Vec::new();
            for (index, mut punch) in projected.punches.into_iter().enumerate() {
                punch.ordinal = start + index + 1;
                ordinals.push(punch.ordinal);
                day.punches.push(punch);
            }
            day.unresolved_slots.extend(
                projected
                    .unresolved_slots
                    .iter()
                    .map(|slot| format!("{row_index}:{slot}")),
            );
            day.missing_punch = !day.unresolved_slots.is_empty();
            additional.push(AdditionalRow {
                date: day.date.clone(),
                row_index,
                row_class: clean(attr(*row, "class").unwrap_or("")),
                pay_code: projected.pay_code,
                allocation1: projected.allocation1,
                allocation2: projected.allocation2,
                hours: projected.hours,
                total_hours: projected.total_hours,
                dollars: projected.dollars,
                exception_text: projected.exception_text,
                waiver_checked: projected.waiver_checked,
                comments: projected.comments,
                unresolved_slots: projected.unresolved_slots,
                punch_ordinals: ordinals,
            });
        }
        let weekly_totals = rows
            .iter()
            .filter(|row| weekly(**row))
            .map(|row| {
                numeric(
                    &row.child_elements()
                        .nth(1)
                        .map(|cell| text(*cell, true))
                        .unwrap_or_default(),
                )
            })
            .collect::<Vec<_>>();
        let period_total_hours = weekly_totals
            .iter()
            .try_fold(0., |sum, value| value.map(|v| sum + v))
            .map(fixed);
        let bound = |key: &str| source.period[key].as_str().unwrap_or("").to_owned();
        Ok(Record {
            version: 2,
            source_format: "paycom-timecard-dom.v2",
            employee_code: self.employee()?,
            period_start: bound("start"),
            period_end: bound("end"),
            period_key: bound("key"),
            source_url: source.url.to_owned(),
            page_title: self.title(),
            headers,
            days,
            additional_rows: additional,
            weekly_totals,
            period_total_hours,
            approvals: self.generic("approvals-table"),
            attestations: self.generic("timecard-attestation-table"),
            meal_waivers: self.generic("meal-waivers-table"),
        })
    }
}

/// The period a key names: fourteen days from a Sunday to a Saturday.
fn period(key: &str) -> Read<Vec<String>> {
    let (start, end) = key
        .split_once('_')
        .ok_or(Unreadable::Invalid("invalid_period"))?;
    let parse = |value: &str| {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .filter(|d| d.to_string() == value)
            .ok_or(Unreadable::Invalid("invalid_period"))
    };
    let (start, end) = (parse(start)?, parse(end)?);
    if start.weekday() != chrono::Weekday::Sun
        || end.weekday() != chrono::Weekday::Sat
        || (end - start).num_days() != 13
    {
        return invalid("invalid_period");
    }
    Ok((0..14)
        .map(|i| (start + chrono::Duration::days(i)).to_string())
        .collect())
}
fn number_or_null(value: Option<f64>) -> bool {
    value.is_none_or(|v| v.is_finite() && v >= 0.)
}
fn comments_valid(comments: &[String]) -> bool {
    comments.len() <= 20 && comments.iter().all(|c| bounded(c, 2000))
}
fn generic_valid(rows: &[Vec<String>]) -> bool {
    rows.len() <= 500
        && rows
            .iter()
            .all(|row| row.len() <= 20 && row.iter().all(|cell| bounded(cell, 1000)))
}
/// `/^(?:[1-9]|1[0-6]):(?:i1|o1|i2|o2)$|^(?:i1|o1|i2|o2)$/`.
fn unresolved_valid(slot: &str) -> bool {
    match slot.split_once(':') {
        Some((row, name)) => SLOTS.contains(&name) && (1..=16).any(|n| n.to_string() == row),
        None => SLOTS.contains(&slot),
    }
}
/// `timecard.js`'s `validatePunch`, for what construction does not already guarantee.
fn punch_valid(punch: &Punch) -> Read<()> {
    if punch.row_index > 16 || !time(&punch.display_time) {
        return invalid("timecard_punch_invalid");
    }
    if !bounded(&punch.clock_name, 200)
        || !bounded(&punch.clock_code, 50)
        || !bounded(&punch.comment, 2000)
        || punch.provenance_available
            && (!KINDS.contains(&punch.kind.as_str())
                || !time(&punch.actual_time)
                || !time(&punch.rounded_time))
    {
        return invalid("timecard_provenance_invalid");
    }
    Ok(())
}
/// `timecard.js`'s `validateTimecardRecord`, for what construction does not guarantee.
fn validate(record: &Record, source: &Source) -> Read<()> {
    if source.employee.len() != 4 || !source.employee.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return invalid("invalid_employee_code");
    }
    let dates = period(source.period["key"].as_str().unwrap_or(""))?;
    if !record.employee_code.is_empty() && record.employee_code != source.employee {
        return Err(Unreadable::WrongEmployee);
    }
    if record.employee_code != source.employee
        || record.period_start != dates[0]
        || record.period_end != dates[13]
        || record.period_key != format!("{}_{}", dates[0], dates[13])
        || record.source_url != source.url
        || record.page_title != "Timecard Editor"
    {
        return invalid("timecard_identity_invalid");
    }
    let without_waiver = HEADERS.iter().filter(|h| **h != "waiver");
    if !(record
        .headers
        .iter()
        .map(String::as_str)
        .eq(HEADERS.iter().copied())
        || record
            .headers
            .iter()
            .map(String::as_str)
            .eq(without_waiver.copied()))
    {
        return invalid("timecard_header_invalid");
    }
    if record.days.len() != 14 {
        return invalid("timecard_day_count_invalid");
    }
    if record.additional_rows.len() > 200 {
        return invalid("timecard_additional_row_invalid");
    }
    for (index, day) in record.days.iter().enumerate() {
        if day.date != dates[index] {
            return invalid("timecard_date_sequence_invalid");
        }
        if day.label != LABELS[index % 7] {
            return invalid("timecard_day_label_invalid");
        }
        if !bounded(&day.pay_code, 100) {
            return invalid("timecard_pay_code_invalid");
        }
        if !bounded(&day.allocation1, 300) || !bounded(&day.allocation2, 300) {
            return invalid("timecard_allocation_invalid");
        }
        if !bounded(&day.exception_text, 2000) {
            return invalid("timecard_exception_invalid");
        }
        if ![day.hours, day.total_hours, day.dollars]
            .into_iter()
            .all(number_or_null)
        {
            return invalid("timecard_day_number_invalid");
        }
        if !comments_valid(&day.comments) {
            return invalid("timecard_day_comments_invalid");
        }
        if day.unresolved_slots.len() > 32
            || !day.unresolved_slots.iter().all(|s| unresolved_valid(s))
            || day.unresolved_slots.iter().collect::<HashSet<_>>().len()
                != day.unresolved_slots.len()
        {
            return invalid("timecard_missing_punch_invalid");
        }
        if day.punches.len() > 32 {
            return invalid("timecard_punch_invalid");
        }
        day.punches.iter().try_for_each(punch_valid)?;
    }
    let mut rows = HashSet::new();
    for row in &record.additional_rows {
        if !dates.contains(&row.date)
            || !(1..=16).contains(&row.row_index)
            || !rows.insert((row.date.as_str(), row.row_index))
            || !bounded(&row.row_class, 300)
            || !bounded(&row.pay_code, 2000)
            || !bounded(&row.allocation1, 300)
            || !bounded(&row.allocation2, 300)
            || ![row.hours, row.total_hours, row.dollars]
                .into_iter()
                .all(number_or_null)
            || !bounded(&row.exception_text, 2000)
            || !comments_valid(&row.comments)
        {
            return invalid("timecard_additional_row_invalid");
        }
    }
    let [first, second] = record.weekly_totals.as_slice() else {
        return invalid("timecard_weekly_total_invalid");
    };
    let (Some(first), Some(second)) = (*first, *second) else {
        return invalid("timecard_weekly_total_invalid");
    };
    if !number_or_null(Some(first)) || !number_or_null(Some(second)) {
        return invalid("timecard_weekly_total_invalid");
    }
    match record.period_total_hours {
        Some(total)
            if total.is_finite()
                && total >= 0.
                && (total - (0. + first + second)).abs() <= 0.011 => {}
        _ => return invalid("timecard_period_total_invalid"),
    }
    if !generic_valid(&record.approvals) {
        return invalid("timecard_approval_invalid");
    }
    if !generic_valid(&record.attestations) {
        return invalid("timecard_attestation_invalid");
    }
    if !generic_valid(&record.meal_waivers) {
        return invalid("timecard_waiver_invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const COLUMNS: &[&str] = &[
        "date",
        "paycode",
        "i1",
        "allocation1",
        "o1",
        "i2",
        "allocation2",
        "o2",
        "hours",
        "total_hours",
        "amount",
        "exception-points",
        "comment",
        "missing-punch",
        "delete",
    ];
    fn period() -> Value {
        let dates = (0..14)
            .map(|i| {
                (NaiveDate::from_ymd_opt(2026, 9, 13).unwrap() + chrono::Duration::days(i))
                    .to_string()
            })
            .collect::<Vec<_>>();
        json!({"start":"2026-09-13","end":"2026-09-26","key":"2026-09-13_2026-09-26","dates":dates})
    }
    fn row(cells: &[(&str, &str)]) -> String {
        let cell = |name: &str| {
            cells
                .iter()
                .find(|(n, _)| *n == name)
                .map_or("", |(_, v)| *v)
        };
        format!(
            "<tr>{}</tr>",
            COLUMNS
                .iter()
                .map(|c| format!("<td>{}</td>", cell(c)))
                .collect::<String>()
        )
    }
    fn punch(time: &str) -> String {
        format!(
            r#"<span class="current-timecard-cell">{time}</span><div class="readOnly-combined-cell" style="display:none">{time} edited</div>"#
        )
    }
    /// A page shaped like Paycom's: Sundays worked 8 hours, a weekly total per week.
    /// `sunday` replaces the first Sunday's rows.
    fn page(code: &str, doctype: &str, sunday: Option<String>) -> String {
        let mut rows = String::new();
        for index in 0..14 {
            let date =
                NaiveDate::from_ymd_opt(2026, 9, 13).unwrap() + chrono::Duration::days(index);
            let heading = format!("{} ({})", LABELS[index as usize % 7], date.format("%m/%d"));
            match (&sunday, index) {
                (Some(custom), 0) => rows.push_str(&custom.replace("HEADING", &heading)),
                _ if index % 7 == 0 => rows.push_str(&row(&[
                    ("date", &heading),
                    ("paycode", "REG"),
                    ("i1", &punch("08:00 AM")),
                    ("o1", &punch("04:00 PM")),
                    ("hours", "8"),
                    ("total_hours", "8"),
                ])),
                _ => rows.push_str(&row(&[("date", &heading), ("hours", "0")])),
            }
            if index % 7 == 6 {
                rows.push_str("<tr><td>Weekly Totals</td><td>8</td></tr>");
            }
        }
        format!(
            r#"{doctype}<html><head><title>Timecard Editor</title></head><body>
            <input name="firstrefno" type="hidden" value="{code}">
            <table id="tbltimesheet"><thead><tr>{}</tr></thead><tbody>{rows}</tbody></table>
            <table id="approvals-table"><tbody><tr><td>No Records Found</td></tr></tbody></table>
            </body></html>"#,
            COLUMNS
                .iter()
                .map(|c| format!(r#"<th data-column="{c}">{c}</th>"#))
                .collect::<String>()
        )
    }
    fn read(html: &str) -> Read<Value> {
        let period = period();
        timecard(
            html,
            &Source {
                employee: "AA01",
                period: &period,
                url: "https://www.paycomonline.net/timecard",
            },
        )
    }

    #[test]
    fn reads_the_shown_punch_times_and_reconciles_them_into_cards() {
        let record = read(&page("AA01", "<!doctype html>", None)).unwrap();
        assert_eq!(record["pageTitle"], "Timecard Editor");
        assert_eq!(record["weeklyTotals"], json!([8.0, 8.0]));
        assert_eq!(record["periodTotalHours"], json!(16.0));
        assert_eq!(record["approvals"], json!([]));
        let sunday = &record["days"][0];
        assert_eq!(sunday["date"], "2026-09-13");
        assert_eq!(sunday["label"], "SUN");
        assert_eq!(sunday["punches"][0]["displayTime"], "08:00 AM");
        assert_eq!(sunday["punches"][1]["slot"], "o1");
        assert_eq!(sunday["punches"][1]["ordinal"], 2);
        let cards = super::super::collection::project(&record, "AA01").unwrap();
        assert_eq!(cards.len(), 14);
        assert_eq!(cards[0]["hours"], json!(8.0));
        assert_eq!(
            cards[0]["punches"],
            json!([{"in":"08:00 AM","out":"04:00 PM","hours":null,"inKind":null,"outKind":null}])
        );
        assert_eq!(cards[1]["status"], "No punches");
    }

    #[test]
    fn folds_a_following_pay_code_row_into_its_day() {
        let sunday = row(&[("date", "HEADING")])
            + &row(&[
                ("paycode", "REG"),
                ("i1", &punch("8:00 AM")),
                ("o1", "??"),
                ("hours", "8"),
                ("total_hours", "8"),
            ]);
        let record = read(&page("AA01", "<!doctype html>", Some(sunday.clone()))).unwrap();
        let day = &record["days"][0];
        assert_eq!(day["punches"][0]["rowIndex"], 1);
        assert_eq!(day["punches"][0]["displayTime"], "08:00 AM");
        assert_eq!(day["unresolvedSlots"], json!(["1:o1"]));
        assert_eq!(day["missingPunch"], true);
        assert_eq!(record["additionalRows"][0]["punchOrdinals"], json!([1]));
        assert_eq!(
            record["additionalRows"][0]["unresolvedSlots"],
            json!(["o1"])
        );
    }

    #[test]
    fn reads_punch_history_and_change_requests_from_their_markup() {
        let history = "IN DAY&lt;br&gt;Actual: 07:58 AM&lt;br/&gt;Rounded: 08:00 AM<br>Clock: \
            Front  Door (12)<br>Comment: on&amp;time";
        // Paycom keeps the shown time a direct child of the cell; history and requests
        // sit beside it.
        let pending = format!(
            r#"{}<i class="pcrPending" title="Operation: Edit&lt;br&gt;Current Kind: out break&lt;br&gt;Current Time: 04:00 pm&lt;br&gt;Requested Kind: OUT LUNCH&lt;br&gt;Requested Time: 04:30 PM"></i><b title="OUT DAY&lt;br&gt;Actual: 04:01 PM&lt;br&gt;Rounded: 04:00 PM"></b>"#,
            punch("04:00 PM")
        );
        let sunday = row(&[
            ("date", "HEADING"),
            (
                "i1",
                &format!(r#"{}<i title="{history}"></i>"#, punch("08:00 AM")),
            ),
            ("o1", &pending),
            ("hours", "8"),
            ("total_hours", "8"),
            ("comment", r#"<i title="Comment:  Late start"></i>"#),
        ]);
        let record = read(&page("AA01", "<!doctype html>", Some(sunday.clone()))).unwrap();
        let day = &record["days"][0];
        let first = &day["punches"][0];
        assert_eq!(first["kind"], "IN DAY");
        assert_eq!(first["actualTime"], "07:58 AM");
        assert_eq!(first["roundedTime"], "08:00 AM");
        assert_eq!(first["clockName"], "Front Door");
        assert_eq!(first["clockCode"], "12");
        assert_eq!(first["comment"], "on&time");
        assert_eq!(first["changeDetailState"], "not_applicable");
        assert_eq!(day["comments"], json!(["Late start"]));
        let out = &day["punches"][1];
        assert_eq!(out["kind"], "OUT DAY");
        assert_eq!(out["actualTime"], "04:01 PM");
        assert_eq!(out["changeRequestStatus"], "pending");
        assert_eq!(out["approved"], false);
        assert_eq!(out["changeOperation"], "edit");
        assert_eq!(out["currentKind"], "OUT LUNCH");
        assert_eq!(out["currentTime"], "04:00 PM");
        assert_eq!(out["requestedKind"], "OUT LUNCH");
        assert_eq!(out["requestedTime"], "04:30 PM");
        assert_eq!(out["changeNote"], Value::Null);
        assert_eq!(out["changeDetailState"], "complete");
        // The shown time must be the cell's own child, as `timecard.js` requires.
        let wrapped = pending.replacen(
            r#"<span class="current-timecard-cell">04:00 PM</span>"#,
            r#"<div><span class="current-timecard-cell">04:00 PM</span></div>"#,
            1,
        );
        let sunday = row(&[("date", "HEADING"), ("o1", &wrapped)]);
        assert_eq!(
            read(&page("AA01", "<!doctype html>", Some(sunday))),
            Err(Unreadable::Invalid("timecard_punch_invalid"))
        );
    }

    #[test]
    fn a_pending_change_on_the_cell_itself_is_read_completely() {
        let cell = format!(
            r#"{}<i title="OUT DAY&lt;br&gt;Actual: 04:02 PM&lt;br&gt;Rounded: 04:00 PM"></i>"#,
            punch("04:00 PM")
        );
        let sunday = format!(
            r#"<tr><td>HEADING</td><td></td><td>{}</td><td></td><td class="pcrPending" data-pcr-operation="Edit" data-pcr-current-kind="OUT BREAK" data-pcr-current-time="04:00 pm" data-pcr-requested-kind="out lunch" data-pcr-requested-time="04:30 PM">{cell}</td><td></td><td></td><td></td><td>8</td><td>8</td><td></td><td></td><td></td><td></td><td></td></tr>"#,
            punch("08:00 AM")
        );
        let record = read(&page("AA01", "<!doctype html>", Some(sunday.clone()))).unwrap();
        let out = &record["days"][0]["punches"][1];
        assert_eq!(out["changeRequestStatus"], "pending");
        assert_eq!(out["changeOperation"], "edit");
        assert_eq!(out["currentKind"], "OUT LUNCH");
        assert_eq!(out["currentTime"], "04:00 PM");
        assert_eq!(out["requestedTime"], "04:30 PM");
        assert_eq!(out["changeDetailState"], "complete");
        assert_eq!(out["provenanceAvailable"], true);
        // A second marker, or a direction without every field, is not a change record.
        let doubled = sunday.replace("<i title", r#"<i class="pcrApproved" title"#);
        assert_eq!(
            read(&page("AA01", "<!doctype html>", Some(doubled))),
            Err(Unreadable::Invalid("timecard_pcr_marker_invalid"))
        );
        let partial = sunday.replace(r#" data-pcr-requested-time="04:30 PM""#, "");
        assert_eq!(
            read(&page("AA01", "<!doctype html>", Some(partial))),
            Err(Unreadable::Invalid("timecard_provenance_invalid"))
        );
    }

    #[test]
    fn refuses_another_employee_and_anything_it_cannot_prove() {
        assert_eq!(
            read(&page("BB02", "<!doctype html>", None)),
            Err(Unreadable::WrongEmployee)
        );
        let untitled = page("AA01", "<!doctype html>", None).replace("Timecard Editor", "Sign In");
        assert_eq!(
            read(&untitled),
            Err(Unreadable::Invalid("timecard_identity_invalid"))
        );
        let hours = page("AA01", "<!doctype html>", None)
            .replace("Weekly Totals</td><td>8", "Weekly Totals</td><td>9");
        assert!(
            read(&hours).is_ok(),
            "reconciling hours is `project`'s check"
        );
        let unknown = row(&[
            ("date", "HEADING"),
            (
                "i1",
                &format!(r#"<div class="pcrMaybe">{}</div>"#, punch("08:00 AM")),
            ),
        ]);
        assert_eq!(
            read(&page("AA01", "<!doctype html>", Some(unknown))),
            Err(Unreadable::Invalid("timecard_pcr_marker_invalid"))
        );
        let control = row(&[
            ("date", "HEADING"),
            ("paycode", r#"<input type="number" value="1">"#),
        ]);
        assert_eq!(
            read(&page("AA01", "<!doctype html>", Some(control))),
            Err(Unreadable::Invalid("timecard_control_unsupported"))
        );
    }

    #[test]
    fn classes_and_ids_ignore_case_only_in_quirks_mode() {
        let shouting = |doctype: &str| {
            page("AA01", doctype, None)
                .replace("current-timecard-cell", "Current-Timecard-Cell")
                .replace("tbltimesheet", "TblTimesheet")
        };
        assert!(read(&shouting("")).is_ok());
        assert_eq!(
            read(&shouting("<!doctype html>")),
            Err(Unreadable::Invalid("timecard_identity_invalid"))
        );
    }

    #[test]
    fn text_follows_the_browser() {
        assert_eq!(clean("\u{feff} a \u{a0}\n b\u{3000}"), "a b");
        assert_eq!(decode("A&lt;br&gt;B"), "A\nB");
        assert_eq!(decode("A&amp;lt;br&amp;gt;B"), "A<br>B");
        assert_eq!(decode("  x\t\ty  "), "x y");
        assert_eq!(line_breaks("a<BR />b<br\t>c<bra>"), "a\nb\nc<bra>");
        assert_eq!(shown_time("8:05 PM").as_deref(), Some("08:05 PM"));
        assert_eq!(shown_time("00:05 PM"), None);
        assert_eq!(
            day_header(" MON  (09/14) "),
            Some(("MON".into(), "09/14".into()))
        );
        assert_eq!(punch_kind("out break (edited)"), "OUT LUNCH");
        assert_eq!(punch_kind("IN DAYS"), "");
        assert_eq!(clock("Door (A (1)"), ("Door (A".into(), "1".into()));
        assert_eq!(clock("Door (1) x"), ("Door (1) x".into(), String::new()));
        assert_eq!(slice_from("Cloc\u{212a}: x", 6), " x");
    }

    #[test]
    fn numbers_follow_javascript() {
        for (text, value) in [
            ("8", Some(8.)),
            ("$1,234.50", Some(1234.5)),
            ("0x10", Some(16.)),
            (".5", Some(0.5)),
            ("5.", Some(5.)),
            ("1e2", Some(100.)),
            ("$", Some(0.)),
            ("", None),
            ("-", None),
            ("-1", None),
            ("inf", None),
            ("Infinity", None),
            ("1_0", None),
        ] {
            assert_eq!(numeric(text), value, "{text:?}");
        }
        // `toFixed` rounds an exact tie up and keeps the binary value's side otherwise.
        assert_eq!(fixed(0.125), 0.13);
        assert_eq!(fixed(1.005), 1.0);
        assert_eq!(fixed(8.0 + 7.75), 15.75);
        assert_eq!(fixed(0.1 + 0.2), 0.3);
    }
}
