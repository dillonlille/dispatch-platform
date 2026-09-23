//! Operator-only observations of Cortex. Never run by CI or print provider records.
use super::*;
use crate::{db, job_metrics::Recorder, meals::Scope};
use std::path::PathBuf;

fn env_path(name: &str) -> Result<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| Error::new("benchmark_configuration_required", 400))
}
/// The requests a tab's document made, from its own resource timing: data requests
/// by masked address (a path segment with a digit is an identifier; query values
/// are dropped) with their largest size and time, and other kinds counted.
const REQUESTS: &str = r#"(()=>{const mask=s=>/\d/.test(s)||s.length>32?'{id}':s;
  const rows={},other={},all=performance.getEntriesByType('resource');
  for(const e of all){
    if(!['fetch','xmlhttprequest'].includes(e.initiatorType)){other[e.initiatorType]=(other[e.initiatorType]||0)+1;continue;}
    const u=new URL(e.name),names=[...new Set(u.searchParams.keys())].sort();
    const key=u.host+u.pathname.split('/').map(mask).join('/')+(names.length?'?'+names.join('&'):'');
    const r=rows[key]||(rows[key]={count:0,maxBytes:0,maxMs:0});
    r.count++;r.maxBytes=Math.max(r.maxBytes,e.decodedBodySize||0);r.maxMs=Math.max(r.maxMs,Math.round(e.duration));}
  return {data:rows,other,entries:all.length,transferBytes:all.reduce((s,e)=>s+(e.transferSize||0),0),
    decodedBytes:all.reduce((s,e)=>s+(e.decodedBodySize||0),0)};})()"#;

// Which data requests Cortex's itinerary pages make: signs in, loads the list and one
// route's details as a collection does, and prints what each document requested.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn record_data_requests() -> Result<()> {
    let dsp = env_path("DISPATCH_BENCHMARK_DSP")?;
    let profile = dsp.join("state/browsers/cortex-browseros");
    let runtime = browseros::Runtime::new(
        Path::new("/opt/dispatch-browseros/0.50.5/browseros"),
        Path::new("/usr/local/libexec/dispatch-dev/bwrap"),
        &env_path("DISPATCH_BENCHMARK_WORKER")?,
        &env_path("DISPATCH_BENCHMARK_RUNS")?,
        1,
    )?;
    let browser = runtime
        .start(
            &profile,
            browseros::Mode::Windowed,
            browseros::NetworkPolicy::Cortex,
        )
        .await?;
    let mut driver = Driver::new(browser, &profile, None).await?;
    let result = async {
        let secrets = dsp.join("secrets");
        let credentials = crate::crypto::decrypt(
            &db::key_file(&secrets.join("vault.key"))?,
            &format!("{}:cortex:2", dsp.file_name().unwrap().to_str().unwrap()),
            &std::fs::read_to_string(secrets.join("cortex.enc"))?,
        )?;
        let started = Instant::now();
        let signed = driver
            .request(json!({"action":"start","credentials":credentials}))
            .await;
        eprintln!(
            "REQUESTS {}",
            json!({"signIn":signed.as_ref().map(|v|s(v,"type").to_owned()).unwrap_or_else(|e|e.code.clone()),
                "ms":started.elapsed().as_millis()})
        );
        ensure(
            signed.is_ok_and(|v| v["type"] == "ready"),
            "benchmark_verification_required",
            409,
        )?;
        let scope: Scope = serde_json::from_str(
            &std::env::var("DISPATCH_BENCHMARK_SCOPE")
                .map_err(|_| Error::new("benchmark_configuration_required", 400))?,
        )?;
        let metrics = Recorder::new(&json!({}));
        let started = Instant::now();
        let candidates = driver.candidates(&scope, &metrics).await?;
        let list = driver.browser.evaluate(&driver.page.id, REQUESTS).await?;
        eprintln!(
            "REQUESTS {}",
            json!({"page":"list","ms":started.elapsed().as_millis(),"routes":candidates.len(),"observed":list})
        );
        let candidate = candidates
            .first()
            .ok_or_else(|| Error::new("benchmark_no_routes", 409))?;
        let started = Instant::now();
        driver.meal_page(&scope, Some(candidate), &metrics).await?;
        let detail = driver.browser.evaluate(&driver.page.id, REQUESTS).await?;
        eprintln!(
            "REQUESTS {}",
            json!({"page":"detail","ms":started.elapsed().as_millis(),"observed":detail})
        );
        Ok(())
    }
    .await;
    driver.browser.close().await;
    result
}
