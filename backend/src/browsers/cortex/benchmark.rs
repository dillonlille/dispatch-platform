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
        driver.meal_page(&driver.page, &scope, Some(candidate), &metrics).await?;
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

/// The first request the tab makes under `path` while loading `url`, sent on as usual:
/// its method, address and the headers a page may set. Prints only header names.
async fn capture(driver: &Driver, url: &str, path: &str) -> Result<Value> {
    driver
        .page
        .command(
            "Fetch.enable",
            json!({"patterns":[{"urlPattern":format!("*{path}*"),"requestStage":"Request"}]}),
        )
        .await?;
    driver.page.start_navigation(url).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let request = loop {
        ensure(Instant::now() < deadline, "provider_timeout", 504)?;
        let event = driver.browser.event(&driver.page.id).await?;
        if event.is_null() {
            continue;
        }
        driver
            .page
            .command(
                "Fetch.continueRequest",
                json!({"requestId":event["requestId"]}),
            )
            .await?;
        break event["request"].clone();
    };
    driver.page.command("Fetch.disable", json!({})).await?;
    let forbidden = |name: &str| {
        let name = name.to_ascii_lowercase();
        [
            "cookie",
            "host",
            "origin",
            "referer",
            "user-agent",
            "accept-encoding",
            "connection",
            "content-length",
        ]
        .contains(&name.as_str())
            || name.starts_with("sec-")
            || name.starts_with("proxy-")
    };
    let headers = request["headers"]
        .as_object()
        .map(|h| {
            h.iter()
                .filter(|(k, _)| !forbidden(k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    eprintln!(
        "REQUESTS {}",
        json!({"captured":path,"method":request["method"],"hasBody":request["hasPostData"],
            "headers":headers.keys().collect::<Vec<_>>()})
    );
    Ok(json!({"url":request["url"],"method":request["method"],"headers":headers}))
}

/// A capture's routes by id, without the moment each was observed.
fn routes(capture: &Value) -> std::collections::BTreeMap<String, Value> {
    capture["itineraries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|route| {
            let mut route = route.clone();
            route.as_object_mut().map(|r| r.remove("observedAt"));
            (s(&route, "id").to_owned(), route)
        })
        .collect()
}
/// Counts that describe a capture without its values.
fn totals(capture: &Value) -> Value {
    let routes = routes(capture);
    let meals = routes
        .values()
        .flat_map(|r| r["meals"].as_array().cloned().unwrap_or_default())
        .collect::<Vec<_>>();
    json!({"routes":routes.len(),
        "drivers":routes.values().map(|r|s(r,"transporterId").to_owned()).collect::<std::collections::BTreeSet<_>>().len(),
        "completeRoutes":routes.values().filter(|r|r["routeComplete"]==true).count(),
        "completeCoverage":routes.values().filter(|r|r["deliveryCoverage"]=="complete").count(),
        "meals":meals.len(),"openMeals":meals.iter().filter(|m|m["end"].is_null()).count(),
        "lastDeliveryBefore":meals.iter().filter(|m|!m["lastDelivery"].is_null()).count(),
        "firstDeliveryAfter":meals.iter().filter(|m|!m["firstDelivery"].is_null()).count()})
}
/// Where two values differ, as field paths without values or indexes.
fn differences(a: &Value, b: &Value, path: &str, out: &mut std::collections::BTreeSet<String>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys()) {
                differences(
                    x.get(key).unwrap_or(&Value::Null),
                    y.get(key).unwrap_or(&Value::Null),
                    &format!("{path}.{key}"),
                    out,
                );
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (p, q) in x.iter().zip(y) {
                differences(p, q, &format!("{path}[]"), out);
            }
        }
        _ if a != b => {
            out.insert(path.to_owned());
        }
        _ => {}
    }
}

// A whole day collected with one tab, as jobs have, then with two, compared route by
// route and field by field. Amazon's own list response is counted as well, so a
// route missing from both collections would still show. Prints counts and field
// names only.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn compare_tabs() -> Result<()> {
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
        let signed = driver
            .request(json!({"action":"start","credentials":credentials}))
            .await;
        ensure(
            signed.is_ok_and(|v| v["type"] == "ready"),
            "benchmark_verification_required",
            409,
        )?;
        let scope: Scope = serde_json::from_str(
            &std::env::var("DISPATCH_BENCHMARK_SCOPE")
                .map_err(|_| Error::new("benchmark_configuration_required", 400))?,
        )?;
        // Amazon's own list for the day: the app's signed request, sent again as is.
        let origin = driver.origin.clone();
        let request = capture(
            &driver,
            &format!("{origin}{}", scope.list_path()),
            "/operations/execution/api/summaries",
        )
        .await?;
        driver.candidates(&scope, &Recorder::new(&json!({}))).await?;
        let listed = driver
            .browser
            .evaluate(
                &driver.page.id,
                &format!(
                    "fetch({},{{headers:{},credentials:'include',cache:'no-store'}}).then(r=>r.json())\
                     .then(b=>b.itinerarySummaries.filter(s=>s.companyId==={}).length)",
                    json!(request["url"]),
                    request["headers"],
                    json!(scope.provider)
                ),
            )
            .await?;
        eprintln!("PARITY {}", json!({"amazonListsRoutes":listed}));
        let mut captures = Vec::new();
        let runs = std::env::var("DISPATCH_BENCHMARK_TABS").unwrap_or_else(|_| "1,2".into());
        for tabs in runs.split(',').filter_map(|v| v.trim().parse::<usize>().ok()) {
            let metrics = Recorder::new(&json!({}));
            let started = Instant::now();
            let capture = driver
                .collect(&scope, &metrics, None, |_, _| async { Ok(()) }, tabs)
                .await;
            let capture = match capture {
                Ok(capture) => capture,
                Err(error) => {
                    // Which read stalled and why: fixed labels and timings only.
                    let snapshot = serde_json::to_value(metrics.snapshot())?;
                    let hidden = driver
                        .browser
                        .command("Target.getTargets", json!({}), None)
                        .await
                        .map(|t| t["targetInfos"].as_array().map(Vec::len))
                        .ok();
                    eprintln!(
                        "PARITY {}",
                        json!({"tabs":tabs,"error":error.code,"detail":snapshot["detail"],
                            "failures":snapshot["pageReads"]["failures"],"active":snapshot["pageReads"]["active"],
                            "completed":snapshot["pageReads"]["completed"],"targets":hidden})
                    );
                    return Err(error);
                }
            };
            let reads = serde_json::to_value(metrics.snapshot())?["pageReads"].clone();
            eprintln!(
                "PARITY {}",
                json!({"tabs":tabs,"ms":started.elapsed().as_millis(),"routeReads":reads["completed"],
                    "failedReads":reads["failures"].as_array().map(Vec::len),"totals":totals(&capture)})
            );
            captures.push(routes(&capture));
        }
        let (one, two) = (&captures[0], &captures[1]);
        let mut fields = std::collections::BTreeSet::new();
        let mut differing = 0;
        for (id, route) in one {
            if let Some(other) = two.get(id) {
                differences(route, other, "", &mut fields);
                if route != other {
                    differing += 1;
                }
            }
        }
        let only_one = one.keys().filter(|id| !two.contains_key(*id)).count();
        let only_two = two.keys().filter(|id| !one.contains_key(*id)).count();
        eprintln!(
            "PARITY {}",
            json!({"compared":one.len().min(two.len()),"onlyOneTab":only_one,"onlyTwoTabs":only_two,
                "differingRoutes":differing,"differingFields":fields,
                "matchesAmazonList":listed.as_u64()==Some(one.len() as u64)&&listed.as_u64()==Some(two.len() as u64)})
        );
        Ok(())
    }
    .await;
    driver.browser.close().await;
    result
}

/// A tab's state while a route loads: visibility, the app's loading flags and its
/// recent data requests' statuses. Labels, flags and masked paths only.
const DIAGNOSE: &str = r#"(()=>{let root;const seen=new Set();
  for(const element of document.querySelectorAll('*')){const key=Object.keys(element).find(k=>k.startsWith('__reactFiber'));
    for(let fiber=element[key],depth=0;fiber&&depth<80;fiber=fiber.return,depth++){if(seen.has(fiber))break;seen.add(fiber);
      const p=fiber.memoizedProps;if(p&&Array.isArray(p.allItinerarySummaries)&&p.transporterSummary)root=p;}}
  const now=performance.now();
  return {page:/\/documentType\//.test(location.pathname)?'detail':'list',visible:document.visibilityState,focus:document.hasFocus(),
    root:!!root,loadingSummaries:root?root.isLoadingSummaries:null,details:!!(root&&root.itineraryDetails),
    loadingDetails:root?root.isLoadingItineraryDetails:null,
    requests:performance.getEntriesByType('resource').filter(e=>['fetch','xmlhttprequest'].includes(e.initiatorType)&&now-e.startTime<40000)
      .map(e=>({path:new URL(e.name).pathname.split('/').map(s=>/\d/.test(s)||s.length>32?'{id}':s).join('/'),
        status:e.responseStatus,ms:Math.round(e.duration),agoMs:Math.round(now-e.startTime)}))};})()"#;

// Two tabs collecting a day while every tab's state is sampled; prints the samples
// of any tab still loading a route after ten seconds.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn diagnose_tabs() -> Result<()> {
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
    let mut driver = Driver::new(browser.clone(), &profile, None).await?;
    let result = async {
        let secrets = dsp.join("secrets");
        let credentials = crate::crypto::decrypt(
            &db::key_file(&secrets.join("vault.key"))?,
            &format!("{}:cortex:2", dsp.file_name().unwrap().to_str().unwrap()),
            &std::fs::read_to_string(secrets.join("cortex.enc"))?,
        )?;
        let signed = driver
            .request(json!({"action":"start","credentials":credentials}))
            .await;
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
        let done = std::sync::atomic::AtomicBool::new(false);
        let origin = driver.origin.clone();
        let watch = async {
            let mut sessions = std::collections::BTreeMap::<String, (usize, String)>::new();
            let mut loading = std::collections::BTreeMap::<String, u32>::new();
            while !done.load(std::sync::atomic::Ordering::SeqCst) {
                sleep(Duration::from_secs(5)).await;
                let Ok(targets) = browser.command("Target.getTargets", json!({}), None).await else {
                    continue;
                };
                for target in targets["targetInfos"].as_array().into_iter().flatten() {
                    if s(target, "type") != "page" || !s(target, "url").starts_with(&origin) {
                        continue;
                    }
                    let id = s(target, "targetId").to_owned();
                    if !sessions.contains_key(&id) {
                        let Ok(attached) = browser
                            .command("Target.attachToTarget", json!({"targetId":id,"flatten":true}), None)
                            .await
                        else {
                            continue;
                        };
                        let index = sessions.len() + 1;
                        sessions.insert(id.clone(), (index, s(&attached, "sessionId").to_owned()));
                    }
                    let (index, session) = sessions[&id].clone();
                    let Ok(state) = browser.evaluate(&session, DIAGNOSE).await else {
                        continue;
                    };
                    let stuck = state["page"] == "detail"
                        && (state["root"] != true || state["loadingSummaries"] != false
                            || state["details"] != true || state["loadingDetails"] != false);
                    let count = loading.entry(id.clone()).or_default();
                    *count = if stuck { *count + 1 } else { 0 };
                    if *count >= 2 {
                        eprintln!("DIAGNOSE {}", json!({"tab":index,"state":state}));
                    }
                }
            }
        };
        let collect = async {
            let result = driver
                .collect(&scope, &metrics, None, |_, _| async { Ok(()) }, 2)
                .await;
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            result
        };
        let (_, collected) = tokio::join!(watch, collect);
        let snapshot = serde_json::to_value(metrics.snapshot())?;
        eprintln!(
            "DIAGNOSE {}",
            json!({"outcome":collected.as_ref().map(|_|"ok".to_owned()).unwrap_or_else(|e|e.code.clone()),
                "completed":snapshot["pageReads"]["completed"],"detail":snapshot["detail"]})
        );
        collected.map(|_| ())
    }
    .await;
    browser.close().await;
    result
}
