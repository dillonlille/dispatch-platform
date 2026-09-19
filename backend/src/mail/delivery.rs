use crate::{
    Error, Result, State,
    config::Config,
    crypto,
    db::{self, n, s},
    ensure,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
pub async fn mailer(state: Arc<State>, mut stop: tokio::sync::watch::Receiver<bool>) {
    let mut timer = tokio::time::interval(Duration::from_secs(5));
    let mut transport = None;
    loop {
        tokio::select! {_=crate::cancelled(&mut stop)=>break,_=timer.tick()=>{}};
        if !state.config.mail_available() {
            continue;
        }
        if transport.is_none() {
            let config = state.config.clone();
            let result = tokio::task::spawn_blocking(move || MailTransport::new(&config))
                .await
                .unwrap_or_else(|_| Err(Error::new("email_transport_task_failed", 500)));
            match result {
                Ok(client) => {
                    super::transport_status(&state, None);
                    transport = Some(Arc::new(client));
                }
                Err(error) => {
                    super::transport_status(&state, Some(&error.code));
                    crate::observability::event(
                        "error",
                        "mail.transport_failed",
                        json!({"error":error.code,"mode":state.config.mail_mode}),
                    );
                    continue;
                }
            }
        }
        let pending = state
            .read(|db| {
                db.platform.all(
                    "SELECT id,encrypted_message,attempts \
            FROM outbox WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 5",
                    [db::now()],
                )
            })
            .await;
        let rows = match pending {
            Ok(rows) => rows,
            Err(error) => {
                crate::observability::event(
                    "error",
                    "mail.queue_failed",
                    json!({"error":error.code}),
                );
                continue;
            }
        };
        for row in rows {
            if *stop.borrow() {
                break;
            }
            let config = state.config.clone();
            let key = state.key.clone();
            let message = row.clone();
            let client = transport.as_ref().unwrap().clone();
            let result =
                tokio::task::spawn_blocking(move || deliver(&config, &key, &message, &client))
                    .await;
            let result =
                result.unwrap_or_else(|_| Err(Error::new("email_delivery_task_failed", 500)));
            let error = result.err().map(|e| e.code);
            let id = s(&row, "id").to_owned();
            let attempts = n(&row, "attempts");
            crate::observability::event(
                if error.is_some() { "warn" } else { "info" },
                "mail.delivery",
                json!({"mailId":id,"attempt":attempts+1,"error":error}),
            );
            if let Err(error) = state
                .run(move |db| super::record_delivery(db, &id, attempts, error.as_deref()))
                .await
            {
                crate::observability::event(
                    "error",
                    "mail.record_failed",
                    json!({"error":error.code}),
                );
            }
        }
    }
}
enum MailTransport {
    Capture,
    Cloudflare(reqwest::blocking::Client),
    Smtp(lettre::SmtpTransport),
}
impl MailTransport {
    fn new(config: &Config) -> Result<Self> {
        let error = || Error::new("email_transport_configuration_failed", 503);
        Ok(match config.mail_mode.as_str() {
            "capture" => Self::Capture,
            "cloudflare" => Self::Cloudflare(
                reqwest::blocking::Client::builder()
                    .user_agent("Dispatch-Mail/1.0")
                    .timeout(Duration::from_secs(15))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| error())?,
            ),
            _ => Self::Smtp(
                lettre::SmtpTransport::from_url(config.smtp_url.as_deref().ok_or_else(error)?)
                    .map_err(|_| error())?
                    .timeout(Some(Duration::from_secs(15)))
                    .build(),
            ),
        })
    }
}
fn deliver(config: &Config, key: &[u8], row: &Value, transport: &MailTransport) -> Result<()> {
    let value = crypto::decrypt(key, s(row, "id"), s(row, "encrypted_message"))?;
    if let MailTransport::Capture = transport {
        let directory = db::private_dir(&config.platform().join("development-mail"))?;
        db::write_private(
            &directory.join(format!("{}.json", s(row, "id"))),
            &serde_json::to_vec(&value)?,
        )?;
    } else if let MailTransport::Cloudflare(client) = transport {
        ensure(
            s(&value, "environment") == config.environment && s(&value, "origin") == config.origin,
            "email_environment_mismatch",
            503,
        )?;
        let error = || Error::new("email_delivery_failed", 503);
        let response = client
            .post(config.mail_worker_url.as_deref().ok_or_else(error)?)
            .bearer_auth(config.mail_worker_token.as_deref().ok_or_else(error)?)
            .json(&value)
            .send()
            .map_err(|e| {
                Error::new(
                    if e.is_timeout() {
                        "email_timeout"
                    } else if e.is_connect() {
                        "email_connection_failed"
                    } else {
                        "email_request_failed"
                    },
                    503,
                )
            })?;
        ensure(
            response.status().is_success(),
            &format!("email_http_{}", response.status().as_u16()),
            503,
        )?;
    } else {
        use lettre::{
            Transport,
            message::{MultiPart, SinglePart},
        };
        let error = || Error::new("email_delivery_failed", 503);
        let message = lettre::Message::builder()
            .from(
                config
                    .mail_from
                    .as_deref()
                    .ok_or_else(error)?
                    .parse()
                    .map_err(|_| error())?,
            )
            .to(s(&value, "to").parse().map_err(|_| error())?)
            .subject(s(&value, "subject"));
        let message = if let Some(html) = value["html"].as_str() {
            message.multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::plain(s(&value, "text").to_owned()))
                    .singlepart(SinglePart::html(html.to_owned())),
            )
        } else {
            message.body(s(&value, "text").to_owned())
        }
        .map_err(|_| error())?;
        let MailTransport::Smtp(transport) = transport else {
            unreachable!()
        };
        transport.send(&message).map_err(|e| {
            Error::new(
                if e.is_timeout() {
                    "email_timeout"
                } else if e.is_response() {
                    "email_smtp_rejected"
                } else {
                    "email_smtp_delivery_failed"
                },
                503,
            )
        })?;
    }
    Ok(())
}
