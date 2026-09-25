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

/// The weekly scorecard pages, by a short name, Cortex's `pageId` and `tabId`.
const SCORECARD_PAGES: &[(&str, &str, &str)] = &[
    (
        "overview",
        "dsp_dashboard_overview",
        "overview-dsp-weekly-tab",
    ),
    (
        "dcr_dpmo",
        "dsp_return_to_station",
        "dsp-return-to-station-weekly-tab",
    ),
    (
        "dsb",
        "dsp_delivery_concessions",
        "delivery-concessions-weekly-tab",
    ),
    (
        "cdf",
        "dsp_customer_delivery_feedback_negative",
        "customer-delivery-feedback-weekly-tab",
    ),
    ("psb", "dsp_pickup_failures", "dsp-psb-deep-dive-weekly-tab"),
    ("safety", "dsp_safety", "safety-dsp-weekly-tab"),
];
/// What a scorecard page shows and the controls on it, through shadow roots: the
/// address's known query keys, whether a table or a notice is present, custom element
/// tags, iframe hosts, controls whose label, attributes or link name a download, and
/// the short labels of the page's other buttons and links outside table bodies. Labels
/// are kept only when short, without digits and at most three words, so a record
/// cannot pass as one. `click` presses the matching control at `index`.
const SCORECARD_SURVEY: &str = r#"(input) => {
  const mask = (s) => (/\d/.test(s) || s.length > 32 ? '{id}' : s);
  const pattern = /download|export|csv|xlsx|excel|spreadsheet/i;
  const all = [];
  const walk = (root) => {
    for (const e of root.querySelectorAll('*')) {
      all.push(e);
      if (e.shadowRoot) walk(e.shadowRoot);
    }
  };
  walk(document);
  const visible = (e) => e.getClientRects().length > 0;
  const collapse = (s) => (s || '').trim().replace(/\s+/g, ' ');
  const attributes = (e) =>
    ['aria-label', 'title', 'data-testid', 'id', 'class', 'label', 'name', 'variant', 'icon', 'data-icon', 'src', 'alt', 'xlink:href', 'data-tooltip', 'data-original-title', 'data-tip', 'data-for', 'aria-describedby']
      .map((a) => e.getAttribute(a))
      .filter(Boolean);
  const own = (e) =>
    e.tagName.toLowerCase() === 'svg'
      ? collapse(e.querySelector('title')?.textContent)
      : collapse(e.children.length <= 3 ? e.textContent : '');
  const matches = [];
  const structural = ['html', 'body', 'head', 'script', 'style', 'noscript', 'link', 'meta', 'main', 'section', 'nav', 'header', 'footer', 'table', 'thead', 'tbody', 'tr', 'ul', 'ol', 'form'];
  for (const e of all) {
    const tag = e.tagName.toLowerCase();
    if (structural.includes(tag) || (e.textContent || '').length > 200 || matches.length >= 30) continue;
    const href = e.getAttribute('href') || '';
    const candidates = [...attributes(e), own(e), href];
    const hit = candidates.find((s) => pattern.test(s));
    if (!hit) continue;
    let link = null;
    if (href) {
      try {
        const u = new URL(href, location.href);
        link = { scheme: u.protocol, host: u.protocol === 'https:' ? u.host : '', path: u.pathname.split('/').map(mask).join('/'), download: e.hasAttribute('download') };
      } catch { link = { scheme: 'invalid' }; }
    }
    matches.push({ element: e, tag: e.tagName.toLowerCase(), hit: collapse(hit).slice(0, 60), role: e.getAttribute('role'), link, visible: visible(e), inShadow: e.getRootNode() !== document });
  }
  matches.sort((a, b) => Number(b.visible) - Number(a.visible));
  // Controls whose React props or components mention a CSV download, however drawn.
  const componentName = (fiber) => {
    const type = fiber.type;
    if (!type) return null;
    if (typeof type === 'string') return null;
    return type.displayName || type.name || type.render?.displayName || type.render?.name || (type.type && (type.type.displayName || type.type.name)) || null;
  };
  const reactHits = [];
  const clickables = [];
  let reactElements = 0;
  for (const e of all) {
    const key = Object.keys(e).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key) continue;
    reactElements++;
    const found = [];
    const chain = [];
    let clickable = false;
    for (let fiber = e[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
      const name = componentName(fiber);
      if (name && chain.length < 4) chain.push(name);
      if (name && /download|csv|export/i.test(name)) found.push('component:' + name);
      const p = fiber.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      if (depth <= 1 && typeof p.onClick === 'function') clickable = true;
      for (const [k, v] of Object.entries(p)) {
        // Meridian's Clickable takes a plain `download` prop; that alone says nothing.
        if (/csv/i.test(k) || /download(File|Data|Csv|Url|Handler)/i.test(k) || /^on.*download/i.test(k)) found.push(k + '@' + depth);
        else if (typeof v === 'string' && v.length <= 200 && /csv|download/i.test(v)) found.push(k + '=' + v.slice(0, 60));
      }
    }
    const r = e.getBoundingClientRect();
    const box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    const shortText = !e.closest('tbody') && (e.textContent || '').trim().length <= 30 && !/\d/.test(e.textContent || '') ? collapse(e.textContent).slice(0, 30) : '';
    const label = collapse(e.getAttribute('aria-label') || e.getAttribute('title') || '').slice(0, 40);
    if (found.length && reactHits.length < 30)
      reactHits.push({ element: e, tag: e.tagName.toLowerCase(), visible: visible(e), box, props: [...new Set(found)].slice(0, 12), chain, label, text: shortText });
    if (clickable && visible(e) && !e.closest('tbody') && clickables.length < 80)
      clickables.push({ element: e, tag: e.tagName.toLowerCase(), box, chain, label, text: shortText });
  }
  if (input.action === 'click') {
    const c = matches[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, hit: c.hit, tag: c.tag };
  }
  if (input.action === 'clickReact') {
    const c = reactHits[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, props: c.props, tag: c.tag, box: c.box };
  }
  if (input.action === 'clickClickable') {
    const c = clickables[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, chain: c.chain, tag: c.tag, box: c.box, label: c.label, text: c.text };
  }
  // Column headers only: these tables use row headers for the person each row is about.
  const tableHeaders = [...document.querySelectorAll('table')].slice(0, 4).map((table) =>
    [...table.querySelectorAll('thead th')].slice(0, 40).map((th) => collapse(th.textContent).slice(0, 40)));
  const tableBoxes = [...document.querySelectorAll('table')].slice(0, 4).map((table) => {
    const r = table.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  });
  // Each table's action bar, by its component name, with the buttons it holds.
  const actionBars = [];
  const barElements = new Set();
  for (const e of all) {
    const key = Object.keys(e).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key || actionBars.length >= 6) continue;
    let bar = null;
    for (let fiber = e[key], depth = 0; fiber && depth < 3; fiber = fiber.return, depth++)
      if (componentName(fiber) === 'TableActionBar') bar = fiber;
    if (!bar) continue;
    // Only the outermost element of each bar, once.
    if ([...barElements].some((b) => b.contains(e))) continue;
    barElements.add(e);
    const p = bar.memoizedProps || {};
    const csv = p.csvData;
    const r = e.getBoundingClientRect();
    actionBars.push({
      element: e, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      props: Object.keys(p).slice(0, 40),
      csvData: Array.isArray(csv) ? { array: csv.length, item: csv.length ? (Array.isArray(csv[0]) ? { array: csv[0].length } : csv[0] && typeof csv[0] === 'object' ? { keys: Object.keys(csv[0]).slice(0, 80) } : typeof csv[0]) : null } : csv && typeof csv === 'object' ? { keys: Object.keys(csv).slice(0, 40) } : typeof csv,
      buttons: [...e.querySelectorAll('button, a, [role=button]')].map((b) => {
        const br = b.getBoundingClientRect();
        return { element: b, tag: b.tagName.toLowerCase(), box: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)], text: collapse(b.textContent).slice(0, 30), label: collapse(b.getAttribute('aria-label') || b.getAttribute('title') || '').slice(0, 40), svg: !!b.querySelector('svg'), visible: visible(b) };
      }),
    });
  }
  // The first table's React ancestry: component names and prop names, no values.
  const tableProps = [];
  const firstTable = document.querySelector('table');
  if (firstTable) {
    const key = Object.keys(firstTable).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    for (let fiber = firstTable[key], depth = 0; fiber && depth < 25 && tableProps.length < 25; fiber = fiber.return, depth++) {
      const p = fiber.memoizedProps;
      const keys = p && typeof p === 'object' ? Object.keys(p).filter((k) => k !== 'children') : [];
      const name = componentName(fiber);
      if (name || keys.length > 2) {
        const entry = { depth, component: name, props: keys.slice(0, 40) };
        if (p && p.csvDownloadData !== undefined) {
          const d = p.csvDownloadData;
          entry.csvDownloadData = d && typeof d === 'object' ? { keys: Object.keys(d).slice(0, 40), rows: Array.isArray(d.csvDataRows) ? d.csvDataRows.length : typeof d.csvDataRows, rowKeys: Array.isArray(d.csvDataRows) && d.csvDataRows.length && d.csvDataRows[0] && typeof d.csvDataRows[0] === 'object' ? Object.keys(d.csvDataRows[0]).slice(0, 80) : null, displayContext: d.displayContext && typeof d.displayContext === 'object' ? Object.keys(d.displayContext).slice(0, 30) : typeof d.displayContext, fields: Array.isArray(d.fields) ? d.fields.slice(0, 100).map((f) => (typeof f === 'string' ? f : f && typeof f === 'object' ? { header: f.header, value: typeof f.value === 'string' ? f.value : typeof f.value } : typeof f)) : undefined, fileName: typeof d.csvFileName === 'string' ? d.csvFileName : typeof d.fileName === 'string' ? d.fileName : undefined, dataSource: d.dataSource } : typeof d;
        }
        if (p && p.actionBarData !== undefined) entry.actionBarData = p.actionBarData && typeof p.actionBarData === 'object' ? Object.keys(p.actionBarData).slice(0, 40) : typeof p.actionBarData;
        tableProps.push(entry);
      }
    }
  }
  const framework = {
    reactFiber: reactElements,
    reactInternal: all.filter((e) => Object.keys(e).some((k) => k.startsWith('__reactInternalInstance'))).length,
    reactRoot: !!document.querySelector('[data-reactroot]'),
    vue: all.filter((e) => e.__vue__ || e.__vue_app__ || e.__vnode).length,
    angular: all.filter((e) => e.__ngContext__ !== undefined).length + (document.querySelector('[ng-version]') ? 1000 : 0),
    svelte: Object.keys(document.body || {}).filter((k) => k.startsWith('__svelte')).length,
    globals: ['React', 'ReactDOM', 'Vue', 'angular', 'ng', 'Ember', 'jQuery', '$', 'Polymer', 'katal', 'KatalMetrics', 'AmazonUIPageJS', 'webpackChunk', 'System', 'define', 'require'].filter((k) => k in globalThis),
    scripts: [...document.scripts].map((s) => { try { return new URL(s.src, location.href).host + new URL(s.src, location.href).pathname.split('/').map(mask).join('/'); } catch { return 'inline'; } }).slice(0, 30),
  };
  // Anything the page styles as clickable, drawn any way, outside table bodies.
  const pointers = [];
  for (const e of all) {
    if (pointers.length >= 100) break;
    const tag = e.tagName.toLowerCase();
    if (['html', 'body', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'path', 'g', 'use', 'circle', 'rect', 'line', 'polygon', 'polyline'].includes(tag) || e.closest('tbody') || !visible(e)) continue;
    const control = ['a', 'button'].includes(tag) || e.getAttribute('role') === 'button';
    // Labelled buttons and links are listed under chrome already.
    if (control && collapse(e.textContent)) continue;
    const size = e.getBoundingClientRect();
    if (!control && (size.width > 200 || size.height > 80 || getComputedStyle(e).cursor !== 'pointer')) continue;
    const parentPointer = e.parentElement && e.parentElement !== document.body && getComputedStyle(e.parentElement).cursor === 'pointer' && e.parentElement.getClientRects().length > 0;
    if (parentPointer) continue;
    const r = e.getBoundingClientRect();
    const text = (e.textContent || '').trim();
    pointers.push({
      element: e, tag, class: (e.getAttribute('class') || '').slice(0, 60), role: e.getAttribute('role'),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      text: text.length <= 20 && !/\d/.test(text) ? collapse(text) : text.length ? '{text}' : '',
      label: collapse(e.getAttribute('aria-label') || e.getAttribute('title') || '').slice(0, 40),
      svg: !!e.querySelector('svg'), img: !!e.querySelector('img'), children: e.children.length,
    });
  }
  const noDataHits = ['no data', 'not available', 'nothing to show', 'no results', 'no violations', 'no records', 'not yet'].filter((phrase) => new RegExp(phrase, 'i').test(document.body?.innerText || ''));
  const chrome = [];
  const seen = new Set();
  for (const e of all) {
    const tag = e.tagName.toLowerCase();
    const role = e.getAttribute('role');
    const button = ['button', 'a', 'kat-button', 'kat-link', 'kat-dropdown-button', 'kat-icon'].includes(tag) || ['button', 'link', 'menuitem', 'tab'].includes(role);
    if (!button || !visible(e) || e.closest('tbody')) continue;
    const label = collapse(e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('label') || e.textContent);
    if (!label || label.length > 30 || /\d/.test(label) || label.split(' ').length > 3) continue;
    const key = tag + '|' + label;
    if (seen.has(key) || chrome.length >= 80) continue;
    seen.add(key);
    chrome.push({ tag, label, testid: e.getAttribute('data-testid') });
  }
  const custom = {};
  for (const e of all) {
    const tag = e.tagName.toLowerCase();
    if (tag.includes('-')) custom[tag] = (custom[tag] || 0) + 1;
  }
  const links = [];
  const linkKeys = new Set();
  for (const e of all) {
    if (e.tagName.toLowerCase() !== 'a' || e.closest('tbody') || links.length >= 40) continue;
    try {
      const u = new URL(e.getAttribute('href') || '', location.href);
      const key = u.protocol + '//' + u.host + u.pathname.split('/').map(mask).join('/');
      if (linkKeys.has(key)) continue;
      linkKeys.add(key);
      links.push({ to: key, visible: visible(e) });
    } catch {}
  }
  const iframes = [...document.querySelectorAll('iframe')].map((f) => {
    try { return new URL(f.src, location.href).host; } catch { return 'invalid'; }
  });
  if (input.action === 'clickActionBar') {
    const bar = actionBars[input.bar];
    const b = bar && bar.buttons[input.index];
    if (!b) return { clicked: false };
    b.element.click();
    return { clicked: true, tag: b.tag, box: b.box, label: b.label, text: b.text, bar: bar.box };
  }
  if (input.action === 'clickPointer') {
    const c = pointers[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, tag: c.tag, class: c.class, box: c.box, label: c.label, text: c.text };
  }
  const text = document.body?.innerText || '';
  const u = new URL(location.href);
  const shown = ['pageId', 'tabId', 'timeFrame', 'to', 'station'];
  return {
    path: u.pathname,
    query: Object.fromEntries([...u.searchParams].map(([k, v]) => [k, shown.includes(k) ? v : k === 'companyId' ? (/^[0-9a-f-]{36}$/.test(v) ? 'uuid' : 'other') : '{value}'])),
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('table tr').length,
    noData: /no data|not available|nothing to show|no results|no violations|no records|not yet/i.test(text),
    errorText: /something went wrong|try again|unable to|error/i.test(text),
    loading: /loading/i.test(text),
    textLength: text.length,
    width: innerWidth,
    elements: all.length,
    links,
    custom,
    iframes,
    matches: matches.map(({ element, ...c }) => c),
    reactHits: reactHits.map(({ element, ...c }) => c),
    clickables: clickables.map(({ element, ...c }) => c),
    reactElements,
    actionBars: actionBars.map(({ element, buttons, ...c }) => ({ ...c, buttons: buttons.map(({ element, ...b }) => b) })),
    tableProps,
    framework,
    tableHeaders,
    tableBoxes,
    pointers: pointers.map(({ element, ...c }) => c),
    noDataHits,
    chrome,
  };
}"#;
/// Records, in the page, what a download would do without the network: blobs given
/// an object URL, anchors clicked and windows opened. Blob contents are kept for
/// the benchmark to save; addresses are masked.
const DOWNLOAD_HOOK: &str = r#"(() => {
  if (globalThis.__dispatchDownloads) return 'already';
  const log = (globalThis.__dispatchDownloads = []);
  const mask = (s) => (/\d/.test(s) || s.length > 32 ? '{id}' : s);
  const where = (value) => {
    const u = new URL(String(value), location.href);
    return { scheme: u.protocol, host: u.protocol === 'https:' ? u.host : '', path: u.protocol === 'data:' ? '' : u.pathname.split('/').map(mask).join('/') };
  };
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    try {
      if (object instanceof Blob) {
        const record = { kind: 'blob', type: object.type, size: object.size };
        log.push(record);
        if (object.size <= 8 * 1024 * 1024) {
          const reader = new FileReader();
          reader.onload = () => { record.base64 = String(reader.result).split(',')[1] || ''; };
          reader.readAsDataURL(object);
        }
      }
    } catch {}
    return createObjectURL.apply(this, arguments);
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const record = { kind: 'anchor', ...where(this.href), download: this.hasAttribute('download') };
      if (this.href.startsWith('data:') && this.href.length <= 11 * 1024 * 1024) record.dataUrl = this.href;
      log.push(record);
    } catch {}
    return click.apply(this, arguments);
  };
  const open = window.open;
  window.open = function (url) {
    try { log.push({ kind: 'open', ...where(url) }); } catch {}
    return open.apply(this, arguments);
  };
  return 'hooked';
})()"#;
/// The performance API requests the document made, fetched again with the tab's
/// cookies and nothing else: whether that works, and the shape of what comes back as
/// key names and lengths. From the page configuration, the key paths and strings that
/// mention a download or export.
const API_PROBE: &str = r#"(() => { if (globalThis.__dispatchProbe) return 'already'; globalThis.__dispatchProbe = { done: false }; (async () => {
  const entries = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/performance/api/') && !/Photo|photo/.test(n));
  entries.sort((a, b) => Number(b.includes('getPageConfig')) - Number(a.includes('getPageConfig')));
  const seen = new Set();
  const out = [];
  const shape = (v, d = 0) => {
    if (Array.isArray(v)) return { array: v.length, item: v.length ? shape(v[0], d + 1) : null };
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      return d >= 3 ? { keys: keys.slice(0, 60) } : { keys: keys.slice(0, 60), nested: Object.fromEntries(keys.slice(0, 16).map((k) => [k, shape(v[k], d + 1)])) };
    }
    return typeof v;
  };
  const find = (v, path, acc, depth) => {
    if (depth > 10 || acc.length > 80) return;
    if (Array.isArray(v)) { v.slice(0, 40).forEach((x) => find(x, path + '[]', acc, depth + 1)); return; }
    if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        const p = path + '.' + k;
        if (/download|export|csv|xlsx|excel/i.test(k)) acc.push({ path: p, value: typeof x === 'string' ? x.slice(0, 80) : typeof x === 'object' ? shape(x, 3) : x });
        else if (typeof x === 'string' && /download|export|csv|xlsx|excel/i.test(x)) acc.push({ path: p, value: x.slice(0, 80) });
        find(x, p, acc, depth + 1);
      }
  };
  for (const name of entries) {
    const u = new URL(name);
    const key = u.pathname.split('/').pop() + '?' + [...u.searchParams].filter(([k]) => !['dsp', 'dspId'].includes(k)).map(([k, v]) => k + '=' + (/id$/i.test(k) && !/dataSetId/.test(k) ? '{id}' : v)).join('&');
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= 8) break;
    const record = { key, params: Object.fromEntries([...u.searchParams].map(([k, v]) => [k, ['dsp', 'dspId'].includes(k) ? (/^[0-9a-f-]{36}$/.test(v) ? 'uuid' : 'other') : v])) };
    try {
      const r = await fetch(name, { credentials: 'include', cache: 'no-store' });
      record.status = r.status;
      record.contentType = r.headers.get('content-type');
      if (r.ok) {
        const text = await r.text();
        record.bytes = text.length;
        try {
          const json = JSON.parse(text);
          record.shape = shape(json);
          const items = (list) => (Array.isArray(list) ? list : list && typeof list === 'object' ? Object.entries(list).map(([k, v]) => ({ __key: k, ...(v && typeof v === 'object' ? v : { value: v }) })) : []);
          const ident = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? { keys: Object.keys(x).slice(0, 20), id: x.id ?? x.key ?? x.field ?? x.name ?? x.dataKey ?? null, value: typeof x.value === 'string' ? x.value : x.value === undefined ? null : shape(x.value, 3), header: x.header ?? x.label ?? x.displayName ?? x.title ?? null, sortField: x.sortField ?? null, tierField: x.tierField ?? null } : typeof x);
          if (/getPageConfig/.test(name)) {
            const acc = []; find(json, '', acc, 0); record.downloadRefs = acc.slice(0, 6);
            const pc = json.pageConfiguration || {};
            const templates = [];
            for (const group of ['tableTemplates', 'workforceTableTemplates', 'sheetTemplates', 'cardListTemplates', 'sectionTemplates'])
              for (const t of items(pc[group])) {
                const f = t.csvDownloadFormat;
                if (!f && !t.actionBar?.enableCsvDownload) continue;
                templates.push({
                  group, key: t.__key ?? t.id ?? t.templateId ?? t.name ?? null, enabled: t.actionBar?.enableCsvDownload ?? null,
                  csvFileName: f?.csvFileName, tooltip: f?.tooltipMessage, dataSource: f?.dataSource, isColumnHeader: f?.isColumnHeader,
                  templateKeys: Object.keys(t).slice(0, 40), actionBar: t.actionBar ? Object.keys(t.actionBar) : null,
                  tableDataSource: typeof t.dataSource === 'string' ? t.dataSource : t.dataSource ? Object.keys(t.dataSource) : (t.dataSourceId ?? t.tableDataDefinitionId ?? null),
                  fields: Array.isArray(f?.fields) ? f.fields.slice(0, 150).map(ident) : f?.fields === undefined ? null : shape(f.fields, 3),
                });
              }
            record.templates = templates;
            const defs = pc.tableDataDefinitions;
            record.tableDataDefinitions = items(defs).slice(0, 30).map((v) => ({
              key: v.__key ?? v.id ?? null, keys: Object.keys(v).slice(0, 30), dataSetId: v.dataSetId ?? v.dataSource ?? null,
              columns: Array.isArray(v.columns) ? v.columns.slice(0, 150).map(ident) : v.columns ? shape(v.columns, 3) : null,
            }));
            for (const group of ['dataSources', 'remoteDataSources', 'dynamicDataSources'])
              record[group] = items(pc[group]).slice(0, 40).map((d) => ({ key: d.__key ?? d.id ?? null, dataSetId: d.dataSetId ?? d.dataSet ?? d.datasetId ?? null, timeFrame: d.timeFrame ?? null, keys: Object.keys(d).slice(0, 30) }));
            const ctx = json.pageContext || {};
            const weeks = [];
            const scan = (v, d) => { if (d > 5 || weeks.length >= 40) return; if (typeof v === 'string' && /^\d{4}-W\d{2}$|^\d{4}-\d{2}-\d{2}$/.test(v)) weeks.push(v); else if (Array.isArray(v)) v.forEach((x) => scan(x, d + 1)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => scan(x, d + 1)); };
            scan(ctx.dataInterval, 0);
            record.pageContext = { keys: Object.keys(ctx), dataInterval: shape(ctx.dataInterval, 1), intervalValues: weeks, selectedDsp: ctx.selectedDsp ? Object.keys(ctx.selectedDsp) : null, availableDsps: Array.isArray(ctx.availableDsps) ? ctx.availableDsps.length : shape(ctx.availableDsps, 2), selectedStation: ctx.selectedStation ? Object.keys(ctx.selectedStation) : null, selectedTabId: shape(ctx.selectedTabId, 1) };
            record.tableData = Object.fromEntries(Object.entries(json.tableData || {}).slice(0, 20).map(([k, v]) => [k, Array.isArray(v?.rows) ? v.rows.length : shape(v, 2)]));
          } else {
            const table = Object.values(json.tableData || {})[0];
            const rows = table?.rows;
            const describe = (row) => {
              if (typeof row !== 'string') return row && typeof row === 'object' ? { keys: Object.keys(row).slice(0, 150) } : typeof row;
              try {
                const parsed = JSON.parse(row);
                if (Array.isArray(parsed)) return { array: parsed.length, types: [...new Set(parsed.map((x) => typeof x))], identifiers: parsed.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_]*$/.test(x)) ? parsed.slice(0, 150) : null };
                return parsed && typeof parsed === 'object' ? { keys: Object.keys(parsed).slice(0, 150) } : typeof parsed;
              } catch {
                return { length: row.length, commas: (row.match(/,/g) || []).length, tabs: (row.match(/\t/g) || []).length, pipes: (row.match(/\|/g) || []).length };
              }
            };
            if (Array.isArray(rows)) record.rows = { count: rows.length, first: rows.length ? describe(rows[0]) : null, second: rows.length > 1 ? describe(rows[1]) : null, tableKeys: Object.keys(table) };
          }
        } catch { record.parse = 'not_json'; }
      }
    } catch { record.error = 'fetch_failed'; }
    out.push(record);
    globalThis.__dispatchProbe.partial = out;
  }
  globalThis.__dispatchProbe = { done: true, out };
})().catch((e) => { globalThis.__dispatchProbe = { done: true, error: 'probe_failed' }; }); return 'started'; })()"#;

/// A paused response, described without its contents: kind, method, masked address,
/// status, error and the headers that say what it is.
fn describe_response(event: &Value) -> Value {
    let mask = |segment: &str| {
        if segment.chars().any(|c| c.is_ascii_digit()) || segment.len() > 32 {
            "{id}".to_owned()
        } else {
            segment.to_owned()
        }
    };
    let url = url::Url::parse(s(&event["request"], "url")).ok();
    let mut headers = serde_json::Map::new();
    for header in event["responseHeaders"].as_array().into_iter().flatten() {
        let name = s(header, "name").to_ascii_lowercase();
        let value = s(header, "value");
        let kept = match name.as_str() {
            "content-type" | "content-length" | "cache-control" | "x-amz-request-id" => {
                Some(value.to_owned())
            }
            "content-disposition" => Some(format!(
                "{}{}",
                if value.contains("attachment") {
                    "attachment"
                } else {
                    "inline"
                },
                std::path::Path::new(value.trim_end_matches('"'))
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| format!(" .{e}"))
                    .unwrap_or_default()
            )),
            "location" => url::Url::parse(value).ok().map(|u| {
                format!(
                    "{}{}",
                    u.host_str().unwrap_or(""),
                    u.path().split('/').map(mask).collect::<Vec<_>>().join("/")
                )
            }),
            _ => None,
        };
        if let Some(kept) = kept {
            headers.insert(name, json!(kept));
        }
    }
    json!({
        "type": event["resourceType"],
        "method": event["request"]["method"],
        "host": url.as_ref().and_then(|u| u.host_str()).unwrap_or(""),
        "path": url.as_ref().map(|u| u.path().split('/').map(mask).collect::<Vec<_>>().join("/")).unwrap_or_default(),
        "queryKeys": url.as_ref().map(|u| { let mut k: Vec<_> = u.query_pairs().map(|(k, _)| k.into_owned()).collect(); k.sort(); k.dedup(); k }).unwrap_or_default(),
        "status": event["responseStatusCode"],
        "error": event["responseErrorReason"],
        "headers": headers,
    })
}
/// Whether a described response looks like a file a download would produce.
fn looks_like_file(described: &Value) -> bool {
    let kind = s(&described["headers"], "content-type").to_ascii_lowercase();
    s(&described["headers"], "content-disposition").starts_with("attachment")
        || [
            "spreadsheet",
            "excel",
            "csv",
            "octet-stream",
            "zip",
            "ms-excel",
        ]
        .iter()
        .any(|k| kind.contains(k))
}
/// The extension a saved capture gets from its declared type and first bytes.
fn extension(kind: &str, bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"PK") {
        "xlsx"
    } else if kind.contains("csv")
        || kind.starts_with("text/")
        || bytes.starts_with(b"\xef\xbb\xbf")
        || bytes.starts_with(b"\"")
    {
        "csv"
    } else if kind.contains("json") || bytes.starts_with(b"{") || bytes.starts_with(b"[") {
        "json"
    } else {
        "bin"
    }
}
/// Saves a capture privately and describes it: name, size and, for text, its column
/// names and line count.
fn save_capture(
    output: &Path,
    name: &str,
    index: usize,
    kind: &str,
    bytes: &[u8],
) -> Result<Value> {
    let extension = extension(kind, bytes);
    let path = output.join(format!("{name}-{index}.{extension}"));
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?
            .write_all(bytes)?;
    }
    db::private_file(&path, false)?;
    let mut record =
        json!({"file":path.file_name().and_then(|f|f.to_str()),"bytes":bytes.len(),"kind":kind});
    if extension == "csv" {
        let text = String::from_utf8_lossy(bytes);
        let header = text
            .lines()
            .next()
            .unwrap_or("")
            .trim_start_matches('\u{feff}');
        record["columns"] = json!(
            header
                .split(',')
                .map(|c| c.trim_matches('"'))
                .collect::<Vec<_>>()
        );
        record["lines"] = json!(text.lines().count());
    }
    Ok(record)
}

// How each weekly scorecard page offers its spreadsheet, and what the download is:
// signs in, opens the overview without a station or company to see what Cortex
// selects, then for each page probes its API, presses its download control while
// intercepting the tab's document, fetch and XHR responses and watching blob
// downloads in the page. Captures are saved under DISPATCH_BENCHMARK_OUTPUT; only
// masked addresses, header kinds, sizes, control labels, key names and CSV column
// names are printed.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn record_scorecard_downloads() -> Result<()> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let dsp = env_path("DISPATCH_BENCHMARK_DSP")?;
    let output = db::private_dir(&env_path("DISPATCH_BENCHMARK_OUTPUT")?)?;
    let week = std::env::var("DISPATCH_BENCHMARK_WEEK")
        .map_err(|_| Error::new("benchmark_configuration_required", 400))?;
    let station = std::env::var("DISPATCH_BENCHMARK_STATION")
        .map_err(|_| Error::new("benchmark_configuration_required", 400))?;
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
        eprintln!(
            "SCORECARD {}",
            json!({"signIn":signed.as_ref().map(|v|s(v,"type").to_owned()).unwrap_or_else(|e|e.code.clone())})
        );
        ensure(
            signed.is_ok_and(|v| v["type"] == "ready"),
            "benchmark_verification_required",
            409,
        )?;
        let driver = &driver;
        let page = &driver.page;
        let origin = driver.origin.clone();
        // A desktop layout: the pages hide their toolbar behind a mobile menu at 1024 px,
        // and the virtual display is no wider, so the viewport is emulated.
        page.command(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":1600,"height":1000,"deviceScaleFactor":1,"mobile":false}),
        )
        .await?;
        // In the application's world: React's props are not visible from an isolated one.
        let survey = |input: Value| async move {
            let frame = page.frame().await?;
            ensure(page.trusted(s(&frame, "url")), "manual_verification_required", 409)?;
            driver.browser.evaluate(&page.id, &call(SCORECARD_SURVEY, &input)).await
        };
        // Until the page settles: a download control, a table or a notice.
        let settle = |label: &'static str| async move {
            let started = Instant::now();
            let mut last = json!({});
            while started.elapsed() < Duration::from_secs(45) {
                sleep(Duration::from_millis(500)).await;
                match survey(json!({"action":"survey"})).await {
                    Ok(value) => {
                        let ready = value["query"].get("station").is_some()
                            && (!value["matches"].as_array().is_none_or(Vec::is_empty)
                                || !value["reactHits"].as_array().is_none_or(Vec::is_empty)
                                || value["tables"].as_u64().unwrap_or(0) > 0
                                || value["noData"] == true
                                || value["errorText"] == true);
                        last = value;
                        if ready && last["loading"] != true {
                            break;
                        }
                    }
                    Err(error) if error.is_any(PAGE_NOT_READY) => (),
                    Err(error) => return Err(error),
                }
            }
            eprintln!(
                "SCORECARD {}",
                json!({"page":label,"settledMs":started.elapsed().as_millis(),"state":last})
            );
            Ok(last)
        };

        // What Cortex selects for this login when nothing is asked for.
        page.start_navigation(&format!("{origin}/performance?pageId=dsp_dashboard_overview"))
            .await?;
        settle("landing").await?;
        let frame = page.frame().await?;
        let url = url::Url::parse(s(&frame, "url")).map_err(|_| Error::new("cortex_content_incomplete", 502))?;
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        let company = match (query.get("station"), query.get("companyId")) {
            (Some(found), Some(company)) if found == &station => company.clone(),
            (found, _) => {
                eprintln!(
                    "SCORECARD {}",
                    json!({"landing":"station_mismatch","expected":station,"found":found,"hasCompany":query.contains_key("companyId")})
                );
                return Err(Error::new("cortex_station_unavailable", 502));
            }
        };
        let address = |page_id: &str, tab: &str, to: &str| {
            let mut q = url::form_urlencoded::Serializer::new(String::new());
            q.append_pair("pageId", page_id)
                .append_pair("station", &station)
                .append_pair("companyId", &company)
                .append_pair("tabId", tab)
                .append_pair("timeFrame", "Weekly")
                .append_pair("to", to);
            format!("{origin}/performance?{}", q.finish())
        };

        // A week that is not posted yet: the overview for the week after the requested one.
        if let Some((year, number)) = week.split_once("-W")
            && let Ok(number) = number.parse::<u32>()
        {
            page.start_navigation(&address("dsp_dashboard_overview", "overview-dsp-weekly-tab", &format!("{year}-W{:02}", number + 1))).await?;
            settle("next_week_overview").await?;
        }

        for (index, &(name, page_id, tab)) in SCORECARD_PAGES.iter().enumerate() {
            let target = address(page_id, tab, &week);
            if index == 0 {
                // The headers the app sends its data API, by name only.
                capture(driver, &target, "/performance/api/").await?;
            } else {
                page.start_navigation(&target).await?;
            }
            let before = settle(name).await?;
            let requests = driver.browser.evaluate(&page.id, REQUESTS).await.unwrap_or(Value::Null);
            eprintln!("SCORECARD {}", json!({"page":name,"requests":requests}));
            driver.browser.evaluate(&page.id, API_PROBE).await?;
            let probe_started = Instant::now();
            let probe = loop {
                sleep(Duration::from_millis(500)).await;
                let state = driver
                    .browser
                    .evaluate(&page.id, "JSON.stringify(globalThis.__dispatchProbe||{})")
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_str::<Value>(v.as_str().unwrap_or("{}")).ok())
                    .unwrap_or_default();
                if state["done"] == true || probe_started.elapsed() > Duration::from_secs(40) {
                    break state;
                }
            };
            eprintln!(
                "SCORECARD {}",
                json!({"page":name,"apiMs":probe_started.elapsed().as_millis(),"api":probe.get("out").or(probe.get("partial")),"apiError":probe.get("error")})
            );
            let hooked = driver.browser.evaluate(&page.id, DOWNLOAD_HOOK).await?;
            let matches = before["matches"].as_array().cloned().unwrap_or_default();
            let react = before["reactHits"].as_array().cloned().unwrap_or_default();
            let clickables = before["clickables"].as_array().cloned().unwrap_or_default();
            let named = |c: &Value| {
                let text = format!("{} {} {}", c["chain"], s(c, "label"), s(c, "text")).to_ascii_lowercase();
                ["download", "csv", "export", "actionbar", "action-bar"].iter().any(|k| text.contains(k))
            };
            let bars = before["actionBars"].as_array().cloned().unwrap_or_default();
            let bar_button = bars.iter().enumerate().find_map(|(bar, b)| {
                let buttons = b["buttons"].as_array()?;
                let mut icons: Vec<usize> = (0..buttons.len()).filter(|i| buttons[*i]["visible"] == true && s(&buttons[*i], "text").is_empty()).collect();
                icons.sort_by(|a, c| buttons[*c]["box"][0].as_f64().partial_cmp(&buttons[*a]["box"][0].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
                icons.first().map(|i| (bar, *i))
            });
            let (action, chosen) = if let Some((bar, index)) = bar_button {
                let pressed = survey(json!({"action":"clickActionBar","bar":bar,"index":index})).await;
                eprintln!("SCORECARD {}", json!({"page":name,"actionBars":bars,"pressedActionBar":pressed.as_ref().ok(),"error":pressed.as_ref().err().map(|e|e.code.clone())}));
                ("clickActionBar", usize::MAX)
            } else if !matches.is_empty() {
                ("click", matches.iter().position(|c| s(c, "hit").to_ascii_lowercase().contains("download")).unwrap_or(0))
            } else if !react.is_empty() {
                ("clickReact", react.iter().position(|c| c["visible"] == true).unwrap_or(0))
            } else if let Some(index) = clickables.iter().position(named) {
                ("clickClickable", index)
            } else if let Some(index) = {
                // An icon-sized clickable without text above a table's right half.
                let tables = before["tableBoxes"].as_array().cloned().unwrap_or_default();
                let pointers = before["pointers"].as_array().cloned().unwrap_or_default();
                let icon = |c: &Value| {
                    let b = c["box"].as_array().cloned().unwrap_or_default();
                    let (x, y, w, h) = (b.first().and_then(Value::as_f64).unwrap_or(0.0), b.get(1).and_then(Value::as_f64).unwrap_or(0.0), b.get(2).and_then(Value::as_f64).unwrap_or(0.0), b.get(3).and_then(Value::as_f64).unwrap_or(0.0));
                    w > 0.0 && w <= 60.0 && h <= 60.0 && s(c, "text").is_empty()
                        && tables.iter().any(|t| {
                            let t = t.as_array().cloned().unwrap_or_default();
                            let (tx, ty, tw) = (t.first().and_then(Value::as_f64).unwrap_or(0.0), t.get(1).and_then(Value::as_f64).unwrap_or(0.0), t.get(2).and_then(Value::as_f64).unwrap_or(0.0));
                            y >= ty - 140.0 && y <= ty + 40.0 && x >= tx + tw / 2.0
                        })
                };
                let mut candidates: Vec<usize> = (0..pointers.len()).filter(|i| icon(&pointers[*i])).collect();
                candidates.sort_by(|a, b| pointers[*b]["box"][0].as_f64().partial_cmp(&pointers[*a]["box"][0].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
                candidates.first().copied()
            } {
                ("clickPointer", index)
            } else {
                eprintln!("SCORECARD {}", json!({"page":name,"download":"no_control","hooked":hooked}));
                continue;
            };
            let patterns: Vec<Value> = ["Document", "XHR", "Fetch", "Other"]
                .iter()
                .map(|kind| json!({"urlPattern":"*","resourceType":kind,"requestStage":"Response"}))
                .collect();
            page.command("Fetch.enable", json!({"patterns":patterns})).await?;
            if chosen != usize::MAX {
                let pressed = survey(json!({"action":action,"index":chosen})).await?;
                eprintln!("SCORECARD {}", json!({"page":name,"pressed":pressed}));
            }
            let started = Instant::now();
            let mut followed = false;
            let mut seen = Vec::new();
            let mut files = 0;
            let mut polls = 0;
            while started.elapsed() < Duration::from_secs(20) {
                let event = driver.browser.event(&page.id).await?;
                if event.is_null() {
                    polls += 1;
                    if polls % 4 == 0 {
                        let captured = driver
                            .browser
                            .evaluate(&page.id, "(globalThis.__dispatchDownloads||[]).filter(d=>d.base64!==undefined||d.kind!=='blob').length")
                            .await
                            .ok()
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        if captured > 0 && started.elapsed() > Duration::from_secs(3) {
                            break;
                        }
                    }
                    // A control that opens a menu: press the first control that appeared.
                    if !followed && started.elapsed() > Duration::from_millis(1500) {
                        followed = true;
                        if let Ok(after) = survey(json!({"action":"survey"})).await {
                            let now = after["matches"].as_array().cloned().unwrap_or_default();
                            if let Some(new_index) = (0..now.len()).find(|i| !matches.contains(&now[*i])) {
                                let pressed = survey(json!({"action":"click","index":new_index})).await?;
                                eprintln!("SCORECARD {}", json!({"page":name,"menu":now,"pressed":pressed}));
                            }
                        }
                    }
                    continue;
                }
                let described = describe_response(&event);
                let mut record = described.clone();
                if looks_like_file(&described) {
                    match page.command("Fetch.getResponseBody", json!({"requestId":event["requestId"]})).await {
                        Ok(body) => {
                            let bytes = if body["base64Encoded"] == true {
                                STANDARD.decode(s(&body, "body")).unwrap_or_default()
                            } else {
                                s(&body, "body").as_bytes().to_vec()
                            };
                            files += 1;
                            record["saved"] = save_capture(&output, name, files, s(&described["headers"], "content-type"), &bytes)?;
                        }
                        Err(error) => record["bodyError"] = json!(error.code),
                    }
                }
                if page.command("Fetch.continueResponse", json!({"requestId":event["requestId"]})).await.is_err() {
                    let _ = page.command("Fetch.continueRequest", json!({"requestId":event["requestId"]})).await;
                }
                seen.push(record);
            }
            page.command("Fetch.disable", json!({})).await?;
            // What the page did on its own: blobs, anchors and windows.
            sleep(Duration::from_secs(1)).await;
            let mut downloads = driver
                .browser
                .evaluate(&page.id, "JSON.stringify(globalThis.__dispatchDownloads||[])")
                .await
                .ok()
                .and_then(|v| serde_json::from_str::<Vec<Value>>(v.as_str().unwrap_or("[]")).ok())
                .unwrap_or_default();
            for record in &mut downloads {
                let (kind, bytes) = if let Some(base64) = record.get("base64").and_then(Value::as_str) {
                    (s(record, "type").to_owned(), STANDARD.decode(base64).unwrap_or_default())
                } else if let Some(data) = record.get("dataUrl").and_then(Value::as_str) {
                    let (head, body) = data.split_once(',').unwrap_or(("", ""));
                    let kind = head.trim_start_matches("data:").split(';').next().unwrap_or("").to_owned();
                    let bytes = if head.contains(";base64") {
                        STANDARD.decode(body).unwrap_or_default()
                    } else {
                        url::form_urlencoded::parse(body.as_bytes()).map(|(k, _)| k.into_owned()).collect::<String>().into_bytes()
                    };
                    (kind, bytes)
                } else {
                    continue;
                };
                record.as_object_mut().map(|r| { r.remove("base64"); r.remove("dataUrl") });
                files += 1;
                record["saved"] = save_capture(&output, name, files, &kind, &bytes)?;
            }
            let after = survey(json!({"action":"survey"})).await.ok().map(|v| json!({"matches":v["matches"],"chrome":v["chrome"]}));
            eprintln!(
                "SCORECARD {}",
                json!({"page":name,"responses":seen,"inPage":downloads,"files":files,"after":after})
            );
        }
        Ok(())
    }
    .await;
    driver.browser.close().await;
    result
}

/// The scorecard data API, asked from the page with its cookies: the request path's
/// shape, each weekly dataset's row count and the JavaScript types of its fields, and
/// how many rows summary datasets have for weeks past and not yet posted. Field names,
/// types, counts and shapes only; the path segment and DSP parameter go back to the
/// benchmark unprinted so it can repeat one request itself.
const API_SHAPES: &str = r#"(input) => {
  if (globalThis.__dispatchApi) return 'already';
  globalThis.__dispatchApi = { done: false };
  (async () => {
    const shape = (v) => (/^[0-9a-f-]{36}$/.test(v) ? 'uuid' : /^\d+$/.test(v) ? 'digits' : /^[A-Za-z0-9]+$/.test(v) ? 'alnum' : 'other');
    const entries = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/performance/api/') && n.includes('getData'));
    const sample = new URL(entries[0]);
    const segment = sample.pathname.split('/')[3];
    const dsp = sample.searchParams.get('dsp');
    const out = {
      path: { prefix: sample.pathname.split('/').slice(0, 3).join('/'), segment: { shape: shape(segment), length: segment.length, equalsCompany: segment === input.company }, stable: new Set(entries.map((n) => new URL(n).pathname.split('/')[3])).size === 1 },
      dsp: { shape: dsp ? shape(dsp) : null, equalsCompany: dsp === input.company },
      dspId: { present: entries.some((n) => new URL(n).searchParams.has('dspId')), equalsCompany: entries.some((n) => new URL(n).searchParams.get('dspId') === input.company) },
      datasets: [], weeks: [],
    };
    const address = (dataSetId, timeFrame, from, to, program) => {
      const u = new URL(`${location.origin}${out.path.prefix}/${segment}/getData`);
      u.searchParams.set('dataSetId', dataSetId);
      u.searchParams.set('dsp', dsp);
      u.searchParams.set('from', from);
      if (program) u.searchParams.set('program', program);
      u.searchParams.set('station', input.station);
      u.searchParams.set('timeFrame', timeFrame);
      u.searchParams.set('to', to);
      return u.toString();
    };
    const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v !== 'string' ? typeof v : /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'date' : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) ? 'datetime' : /^\d{4}-W\d{2}$/.test(v) ? 'week' : /^-?\d+$/.test(v) ? 'intString' : /^-?\d*\.\d+$/.test(v) ? 'decimalString' : v === '' ? 'empty' : /^(Y|N|true|false|TRUE|FALSE)$/.test(v) ? 'flag' : 'text');
    const fetchRows = async (url) => {
      const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
      const record = { status: r.status };
      if (!r.ok) return record;
      const text = await r.text();
      record.bytes = text.length;
      const json = JSON.parse(text);
      const table = Object.values(json.tableData || {})[0];
      // Each row arrives as a JSON string inside the JSON reply.
      record.rows = Array.isArray(table?.rows) ? table.rows.map((row) => (typeof row === 'string' ? JSON.parse(row) : row)) : [];
      return record;
    };
    const datasets = [
      ['dsp_weekly_cdf', 'Weekly'], ['dsp_weekly_psb', 'Weekly'], ['dsp_station_weekly_team', 'Weekly'], ['dsp_station_weekly_compliance', 'Weekly'],
      ['dsp_station_weekly_working_device', 'Weekly'], ['dsp_station_weekly_quality', 'Weekly'], ['dsp_station_weekly_safety_oss_v2', 'Weekly'],
      ['da_dsp_station_weekly_performance', 'Weekly', 'AMZL'], ['da_dsp_station_weekly_safety_oss_v2', 'Weekly'],
      ['da_dsp_weekly_rts_deep_dive', 'Weekly'], ['da_dsp_weekly_cdf_deep_dive', 'Weekly'],
      ['da_dsp_station_daily_dsb_dnr_tba', 'Daily'], ['da_dsp_daily_psb_stop', 'Daily'], ['da_dsp_station_daily_safety_oss_events_intraday', 'Daily'],
    ];
    for (const [id, timeFrame, program] of datasets) {
      const record = { id, timeFrame };
      try {
        const from = timeFrame === 'Weekly' ? input.week : input.firstDay;
        const to = timeFrame === 'Weekly' ? input.week : input.lastDay;
        const got = await fetchRows(address(id, timeFrame, from, to, program));
        record.status = got.status; record.bytes = got.bytes;
        if (got.rows) {
          record.rows = got.rows.length;
          const fields = {};
          for (const row of got.rows.slice(0, 400)) for (const [k, v] of Object.entries(row)) (fields[k] = fields[k] || new Set()).add(kind(v));
          record.fields = Object.fromEntries(Object.entries(fields).slice(0, 90).map(([k, v]) => [k, [...v].sort().join('|')]));
        }
      } catch { record.error = 'fetch_failed'; }
      out.datasets.push(record);
      globalThis.__dispatchApi.partial = out;
    }
    const [year, number] = input.week.split('-W').map(Number);
    for (const delta of [1, 2, -1, -8, -18, -30]) {
      let n = number + delta, y = year;
      if (n > 52) { n -= 52; y += 1; }
      if (n < 1) { n += 52; y -= 1; }
      const week = `${y}-W${String(n).padStart(2, '0')}`;
      const record = { week, delta };
      for (const id of ['dsp_station_weekly_team', 'da_dsp_station_weekly_performance']) {
        try { const got = await fetchRows(address(id, 'Weekly', week, week, id.startsWith('da_') ? 'AMZL' : undefined)); record[id] = got.rows ? got.rows.length : 'status ' + got.status; } catch { record[id] = 'fetch_failed'; }
      }
      out.weeks.push(record);
    }
    globalThis.__dispatchApi = { done: true, out, segment, dsp };
  })().catch(() => { globalThis.__dispatchApi = { done: true, error: 'probe_failed' }; });
  return 'started';
}"#;

// What a collector reading the scorecard API needs to know: signs in, lets the
// overview resolve the company, records the API's shape, each dataset's fields and
// row counts and its answers for other weeks, then repeats one request from this
// process over plain HTTP with the browser's cookies. Prints shapes, names, types
// and counts only.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn probe_scorecard_api() -> Result<()> {
    let dsp = env_path("DISPATCH_BENCHMARK_DSP")?;
    let week = std::env::var("DISPATCH_BENCHMARK_WEEK")
        .map_err(|_| Error::new("benchmark_configuration_required", 400))?;
    let station = std::env::var("DISPATCH_BENCHMARK_STATION")
        .map_err(|_| Error::new("benchmark_configuration_required", 400))?;
    // Amazon's week runs Sunday to Saturday; its daily datasets take those dates.
    let (first_day, last_day) = {
        let (year, number) = week
            .split_once("-W")
            .ok_or_else(|| Error::new("benchmark_configuration_required", 400))?;
        let monday = chrono::NaiveDate::from_isoywd_opt(
            year.parse()
                .map_err(|_| Error::new("benchmark_configuration_required", 400))?,
            number
                .parse()
                .map_err(|_| Error::new("benchmark_configuration_required", 400))?,
            chrono::Weekday::Mon,
        )
        .ok_or_else(|| Error::new("benchmark_configuration_required", 400))?;
        (
            (monday - chrono::Duration::days(1)).to_string(),
            (monday + chrono::Duration::days(5)).to_string(),
        )
    };
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
        let driver = &driver;
        let page = &driver.page;
        let origin = driver.origin.clone();
        page.start_navigation(&format!("{origin}/performance?pageId=dsp_dashboard_overview"))
            .await?;
        // Until Cortex has chosen the station and company and the page asked for data.
        let started = Instant::now();
        let company = loop {
            ensure(started.elapsed() < Duration::from_secs(45), "cortex_content_incomplete", 502)?;
            sleep(Duration::from_millis(500)).await;
            let frame = page.frame().await?;
            let Ok(url) = url::Url::parse(s(&frame, "url")) else { continue };
            let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            if query.get("station") == Some(&station)
                && let Some(company) = query.get("companyId")
                && driver
                    .browser
                    .evaluate(&page.id, "performance.getEntriesByType('resource').filter(e=>e.name.includes('/performance/api/')&&e.name.includes('getData')).length")
                    .await
                    .ok()
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    > 0
            {
                break company.clone();
            }
        };
        let input = json!({"company":company,"week":week,"station":station,"firstDay":first_day,"lastDay":last_day});
        driver.browser.evaluate(&page.id, &call(API_SHAPES, &input)).await?;
        let started = Instant::now();
        let probe = loop {
            sleep(Duration::from_millis(500)).await;
            let state = driver
                .browser
                .evaluate(&page.id, "JSON.stringify(globalThis.__dispatchApi||{})")
                .await
                .ok()
                .and_then(|v| serde_json::from_str::<Value>(v.as_str().unwrap_or("{}")).ok())
                .unwrap_or_default();
            if state["done"] == true || started.elapsed() > Duration::from_secs(120) {
                break state;
            }
        };
        eprintln!(
            "SCORECARD_API {}",
            json!({"ms":started.elapsed().as_millis(),"error":probe.get("error"),"probe":probe.get("out").or(probe.get("partial"))})
        );
        // The same request from this process: the browser's cookies and user agent, nothing else.
        let (Some(segment), Some(dsp_param)) = (probe["segment"].as_str(), probe["dsp"].as_str()) else {
            return Ok(());
        };
        let cookies = driver.browser.command("Storage.getCookies", json!({}), None).await?;
        let version = driver.browser.command("Browser.getVersion", json!({}), None).await?;
        let jar = reqwest::cookie::Jar::default();
        let mut kept = 0;
        for cookie in cookies["cookies"].as_array().into_iter().flatten() {
            let domain = s(cookie, "domain");
            let host = domain.trim_start_matches('.');
            if !(host == "logistics.amazon.com" || host == "amazon.com") {
                continue;
            }
            let Ok(url) = url::Url::parse(&format!("https://{host}/")) else { continue };
            let mut line = format!("{}={}; Path={}", s(cookie, "name"), s(cookie, "value"), s(cookie, "path"));
            if domain.starts_with('.') {
                line.push_str(&format!("; Domain={host}"));
            }
            if cookie["secure"] == true {
                line.push_str("; Secure");
            }
            jar.add_cookie_str(&line, &url);
            kept += 1;
        }
        let client = reqwest::Client::builder()
            .cookie_provider(std::sync::Arc::new(jar))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(s(&version, "userAgent"))
            .build()
            .map_err(|_| Error::new("browser_unavailable", 503))?;
        let mut target = url::Url::parse(&format!("{origin}/performance/api/{segment}/getData"))
            .map_err(|_| Error::new("egress_denied", 403))?;
        target
            .query_pairs_mut()
            .append_pair("dataSetId", "dsp_weekly_cdf")
            .append_pair("dsp", dsp_param)
            .append_pair("from", &week)
            .append_pair("station", &station)
            .append_pair("timeFrame", "Weekly")
            .append_pair("to", &week);
        let started = Instant::now();
        let response = client
            .get(target)
            .header("Accept", "application/json, text/plain, */*")
            .timeout(Duration::from_secs(30))
            .send()
            .await;
        let summary = match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let content_type = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                let text = response.text().await.unwrap_or_default();
                let rows = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v["tableData"].as_object().and_then(|t| t.values().next().cloned()))
                    .and_then(|t| t["rows"].as_array().map(Vec::len));
                json!({"status":status,"contentType":content_type,"bytes":text.len(),"rows":rows})
            }
            Err(error) => json!({"error":error.to_string().split(':').next().unwrap_or("request_failed")}),
        };
        eprintln!(
            "SCORECARD_API {}",
            json!({"http":summary,"cookiesKept":kept,"ms":started.elapsed().as_millis()})
        );
        Ok(())
    }
    .await;
    driver.browser.close().await;
    result
}
