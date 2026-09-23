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

/// Compares a data request the page made with the props a collection reads from it:
/// re-fetches the same address in the page and reports field names, shapes, and which
/// response fields equal which props. Never values.
const SHAPES: &str = r#"(async input=>{try{
  let root;const seen=new Set();
  for(const element of document.querySelectorAll('*')){
    const key=Object.keys(element).find(k=>k.startsWith('__reactFiber'));
    for(let fiber=element[key],depth=0;fiber&&depth<80;fiber=fiber.return,depth++){
      if(seen.has(fiber))break;seen.add(fiber);const p=fiber.memoizedProps;
      if(p&&Array.isArray(p.allItinerarySummaries)&&p.transporterSummary&&(!input.detail||p.itineraryDetails))root=p;}}
  const entry={name:input.request.url};
  if(!root)return {found:{root:false}};
  const name=k=>/^[a-z][A-Za-z]{0,40}$/.test(k);
  const shape=v=>Array.isArray(v)?'array':v===null?'null':typeof v;
  const keys=v=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).filter(name).sort():[];
  let stage='fetch',response,body;
  try{response=await fetch(entry.name,{method:input.request.method,headers:input.request.headers,
      credentials:'include',cache:'no-store'});
    const type=(response.headers.get('content-type')||'').split(';')[0];
    if(response.status!==200||!/json/.test(type))return {stage,status:response.status,type};
    stage='parse';body=await response.json();}
  catch(e){return {stage,error:String(e&&e.name)};}
  const url=new URL(entry.name);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const where={};
  for(const prop of input.props){
    const value=root[prop];where[prop]={propShape:shape(value)};
    const hits=[];
    for(const [k,v] of Object.entries(body)){if(name(k)&&same(v,value))hits.push(k);}
    if(same(body,value))hits.push('(whole response)');
    where[prop].equalTo=hits;
    // For arrays and objects that are not equal, compare element fields.
    const sample=Array.isArray(value)?value[0]:value&&typeof value==='object'&&!input.keyed?.includes(prop)?value:null;
    if(!hits.length&&sample)where[prop].propFields=keys(sample);
  }
  const fields={};for(const k of Object.keys(body).filter(name))fields[k]=shape(body[k])
    +(Array.isArray(body[k])?':'+body[k].length:'')+(Array.isArray(body[k])&&body[k][0]&&typeof body[k][0]==='object'?' of '+keys(body[k][0]).join(','):'');
  return {status:response.status,type:(response.headers.get('content-type')||'').split(';')[0],
    params:Object.fromEntries([...url.searchParams.keys()].map(k=>[k,k==='historicalDay'||k==='documentType'?url.searchParams.get(k):'(value)'])),
    responseFields:fields,props:where};
}catch(e){return {stage:'compare',error:String(e&&e.name)};}})"#;

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
        "SHAPES {}",
        json!({"captured":path,"method":request["method"],"hasBody":request["hasPostData"],
            "headers":headers.keys().collect::<Vec<_>>()})
    );
    Ok(json!({"url":request["url"],"method":request["method"],"headers":headers}))
}

// How Cortex's data requests relate to what a collection reads from its pages.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn compare_requests_with_props() -> Result<()> {
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
        let metrics = Recorder::new(&json!({}));
        let origin = driver.origin.clone();
        let summaries = capture(
            &driver,
            &format!("{origin}{}", scope.list_path()),
            "/operations/execution/api/summaries",
        )
        .await?;
        let candidates = driver.candidates(&scope, &metrics).await?;
        let list = driver
            .browser
            .evaluate(
                &driver.page.id,
                &call(
                    SHAPES,
                    &json!({"request":summaries,
                    "props":["allItinerarySummaries","transporterSummary"],"keyed":["transporterSummary"]}),
                ),
            )
            .await?;
        eprintln!("SHAPES {}", json!({"page":"list","observed":list}));
        let candidate = candidates
            .first()
            .ok_or_else(|| Error::new("benchmark_no_routes", 409))?;
        let itinerary = capture(
            &driver,
            &format!("{origin}{}", scope.detail_path(candidate.id())),
            "/operations/execution/api/itineraries/",
        )
        .await?;
        driver.meal_page(&scope, Some(candidate), &metrics).await?;
        let detail = driver
            .browser
            .evaluate(
                &driver.page.id,
                &call(
                    SHAPES,
                    &json!({"request":itinerary,"detail":true,
                    "props":["itineraryDetails"]}),
                ),
            )
            .await?;
        eprintln!("SHAPES {}", json!({"page":"detail","observed":detail}));
        Ok(())
    }
    .await;
    driver.browser.close().await;
    result
}

/// Moves the app to another route the way its own links do, without reloading.
const ROUTE: &str = r#"(input=>{window.dispatchMarker=input.marker;
  history.pushState(history.state,'',input.path);
  dispatchEvent(new PopStateEvent('popstate',{state:history.state}));return true;})"#;
/// Whether the document survived, and what it requested since `since` ms.
const SINCE: &str = r#"(input=>({kept:window.dispatchMarker===input.marker,
  links:[...document.querySelectorAll('a[href]')].filter(a=>a.href.includes('/documentType/Itinerary')).length,
  requested:performance.getEntriesByType('resource').filter(e=>e.startTime>=input.since
    &&['fetch','xmlhttprequest'].includes(e.initiatorType)).map(e=>new URL(e.name).pathname.split('/').map(s=>/\d/.test(s)||s.length>32?'{id}':s).join('/')),
  now:performance.now()}))"#;

// Whether a captured signature works for another route, and whether moving between
// routes inside the app loads each one's details without reloading the page.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn probe_route_navigation() -> Result<()> {
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
        let metrics = Recorder::new(&json!({}));
        let origin = driver.origin.clone();
        let candidates = driver.candidates(&scope, &metrics).await?;
        ensure(candidates.len() >= 6, "benchmark_no_routes", 409)?;
        let first = &candidates[0];
        let signature = capture(
            &driver,
            &format!("{origin}{}", scope.detail_path(first.id())),
            "/operations/execution/api/itineraries/",
        )
        .await?;
        driver.meal_page(&scope, Some(first), &metrics).await?;
        // The same signed headers on another route's address.
        let other = s(&signature, "url").replace(first.id(), candidates[1].id());
        let status = driver
            .browser
            .evaluate(
                &driver.page.id,
                &format!(
                    "fetch({},{{headers:{},credentials:'include',cache:'no-store'}}).then(r=>r.status)",
                    json!(other),
                    signature["headers"]
                ),
            )
            .await?;
        eprintln!("ROUTES {}", json!({"signatureOnAnotherRoute":status}));
        // Move through five more routes inside the app.
        for (index, candidate) in candidates.iter().enumerate().skip(1).take(5) {
            let since = driver
                .browser
                .evaluate(&driver.page.id, &call(SINCE, &json!({"marker":"m","since":0})))
                .await?["now"]
                .clone();
            let started = Instant::now();
            driver
                .browser
                .evaluate(
                    &driver.page.id,
                    &call(ROUTE, &json!({"marker":index,"path":scope.detail_path(candidate.id())})),
                )
                .await?;
            let mut first_read = None;
            let mut last = None;
            let mut stable = 0;
            let deadline = Instant::now() + Duration::from_secs(30);
            while Instant::now() < deadline && stable < 2 {
                if let Ok(value) = driver.meal_read(&scope, Some(candidate), &metrics).await {
                    first_read.get_or_insert(started.elapsed().as_millis());
                    let mut evidence = value.clone();
                    if let Some(itinerary) = evidence["itinerary"].as_object_mut() {
                        itinerary.remove("observedAt");
                    }
                    stable = if last.as_ref() == Some(&evidence) { stable + 1 } else { 0 };
                    last = Some(evidence);
                }
                sleep(Duration::from_millis(300)).await;
            }
            let after = driver
                .browser
                .evaluate(&driver.page.id, &call(SINCE, &json!({"marker":index,"since":since})))
                .await?;
            eprintln!(
                "ROUTES {}",
                json!({"route":index,"firstReadMs":first_read,"stableMs":(stable>=2).then(||started.elapsed().as_millis()),
                    "reloaded":after["kept"]!=true,"links":after["links"],"requested":after["requested"]})
            );
        }
        Ok(())
    }
    .await;
    driver.browser.close().await;
    result
}

// Ten route pages read in one tab, then ten more across two tabs, with the peak memory
// of each. Both read the page data exactly as a collection does.
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn probe_parallel_tabs() -> Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
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
    let pid = browser.process_id();
    let peak = std::sync::Arc::new(AtomicU64::new(0));
    let watched = peak.clone();
    let sampler = tokio::spawn(async move {
        loop {
            if let Ok(Some(memory)) =
                tokio::task::spawn_blocking(move || crate::job_metrics::memory(pid)).await
            {
                watched.fetch_max(memory.pss, Ordering::Relaxed);
            }
            sleep(Duration::from_millis(500)).await;
        }
    });
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
        let candidates = driver.candidates(&scope, &metrics).await?;
        ensure(candidates.len() >= 20, "benchmark_no_routes", 409)?;
        peak.store(0, Ordering::Relaxed);
        let started = Instant::now();
        for candidate in &candidates[..10] {
            driver.meal_page(&scope, Some(candidate), &metrics).await?;
        }
        eprintln!(
            "TABS {}",
            json!({"tabs":1,"routes":10,"ms":started.elapsed().as_millis(),
                "peakPssMiB":peak.load(Ordering::Relaxed)/1024/1024})
        );
        let mut second = Driver::new(browser.clone(), &profile, None).await?;
        second.page = Page::open(browser.clone(), driver.origin.clone()).await?;
        second.page.allow_origins(
            &driver
                .origins
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        );
        peak.store(0, Ordering::Relaxed);
        let started = Instant::now();
        let (a, b) = tokio::join!(
            async {
                for candidate in &candidates[10..15] {
                    driver.meal_page(&scope, Some(candidate), &metrics).await?;
                }
                Ok::<_, Error>(())
            },
            async {
                for candidate in &candidates[15..20] {
                    second.meal_page(&scope, Some(candidate), &metrics).await?;
                }
                Ok::<_, Error>(())
            }
        );
        a?;
        b?;
        eprintln!(
            "TABS {}",
            json!({"tabs":2,"routes":10,"ms":started.elapsed().as_millis(),
                "peakPssMiB":peak.load(Ordering::Relaxed)/1024/1024})
        );
        Ok(())
    }
    .await;
    sampler.abort();
    browser.close().await;
    result
}
