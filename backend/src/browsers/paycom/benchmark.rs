//! Operator-only measurements. Never run by CI or print provider records.
use super::*;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

fn env_path(name: &str) -> Result<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| Error::new("benchmark_configuration_required", 400))
}
fn memory_tree(root: u32) -> [u64; 4] {
    let mut processes = Vec::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        let field = |prefix: &str| {
            status
                .lines()
                .find_map(|l| l.strip_prefix(prefix))
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
        };
        processes.push((pid, field("PPid:") as u32, field("VmRSS:")));
    }
    let mut ids = std::collections::HashSet::from([root]);
    loop {
        let before = ids.len();
        for &(pid, parent, _) in &processes {
            if ids.contains(&parent) {
                ids.insert(pid);
            }
        }
        if ids.len() == before {
            break;
        }
    }
    let mut totals = [0; 4];
    for (pid, _, rss) in processes.iter().filter(|(pid, _, _)| ids.contains(pid)) {
        totals[0] += rss;
        match std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")) {
            Ok(smaps) => {
                for line in smaps.lines() {
                    let Some((name, value)) = line.split_once(':') else {
                        continue;
                    };
                    let kib = value
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    match name {
                        "Pss" => totals[1] += kib,
                        "Private_Clean" | "Private_Dirty" | "Private_Hugetlb" => totals[2] += kib,
                        _ => (),
                    }
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(libc::ESRCH) => {}
            Err(_) => totals[3] += 1,
        }
    }
    totals
}
#[tokio::test]
#[ignore = "requires an explicitly selected DSP and authenticated provider profile"]
async fn measure_live_collection() -> Result<()> {
    let dsp = env_path("DISPATCH_BENCHMARK_DSP")?;
    let profile = dsp.join("state/browsers/paycom-browseros");
    let runtime = browseros::Runtime::new(
        std::path::Path::new("/opt/dispatch-browseros/0.50.5/browseros"),
        std::path::Path::new("/usr/local/libexec/dispatch-dev/bwrap"),
        &env_path("DISPATCH_BENCHMARK_WORKER")?,
        &env_path("DISPATCH_BENCHMARK_RUNS")?,
        1,
    )?;
    let browser = runtime
        .start(
            &profile,
            browseros::Mode::Windowed,
            browseros::NetworkPolicy::Paycom,
        )
        .await?;
    let mut driver = Driver::new(browser, &profile, None).await?;
    let peak = Arc::new(std::array::from_fn::<_, 4, _>(|_| AtomicU64::new(0)));
    let counter = peak.clone();
    let pid = driver.browser.process_id();
    let sampler = tokio::spawn(async move {
        loop {
            for (counter, value) in counter.iter().zip(memory_tree(pid)) {
                counter.fetch_max(value, Ordering::Relaxed);
            }
            sleep(Duration::from_secs(1)).await;
        }
    });
    let result = async {
        let secrets = dsp.join("secrets");
        let credentials = crate::core::crypto::decrypt(&db::key_file(&secrets.join("vault.key"))?, &format!("{}:paycom:2",dsp.file_name().unwrap().to_str().unwrap()), &std::fs::read_to_string(secrets.join("paycom.enc"))?)?;
        let auth=driver.authenticate(credentials,false).await?;
        ensure(auth["type"]=="ready","benchmark_verification_required",409)?;
        driver.credentials=Value::Null;
        let timezone=std::env::var("DISPATCH_BENCHMARK_TIMEZONE").map_err(|_|Error::new("benchmark_configuration_required",400))?;
        let started=Instant::now();
        let recorder=crate::core::job_metrics::Recorder::new(&json!({}));
        let data=driver.collect(&timezone, None, &recorder, None, |progress,_| async move {
            if progress % 10 == 0 { eprintln!("BENCH {}",json!({"progress":progress})); }
            Ok(())
        }).await?;
        let elapsed=started.elapsed().as_millis();
        let reads=serde_json::to_value(recorder.snapshot())?["pageReads"].clone();
        eprintln!("BENCH {}",json!({"completedReads":reads["completed"],"directReads":reads["direct"],"spotChecked":reads["spotChecked"],"pageRetries":reads["retries"],"failedReads":reads["failures"].as_array().map(Vec::len)}));
        let collection_peak=peak.each_ref().map(|value| value.load(Ordering::Relaxed));
        let database=rusqlite::Connection::open_with_flags(crate::core::collectors::database_path(&dsp, crate::core::collectors::Provider::Paycom)?,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut expected=std::collections::BTreeMap::new();
        let mut statement=database.prepare("SELECT employee_code,date,hours,status,punches FROM timecards WHERE publication_id=(SELECT id FROM publications WHERE active=1)")?;
        for value in statement.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,f64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))? {
            let (code,date,hours,status,punches)=value?;
            expected.insert((code.clone(),date.clone()),json!({"employeeCode":code,"date":date,"hours":hours,"status":status,"punches":serde_json::from_str::<Value>(&punches)?}));
        }
        let records=data["timecards"].as_array().unwrap();
        let mut equal=0; let mut changed=0; let mut added=0;
        let mut differences=std::collections::BTreeSet::new();
        for card in records {
            match expected.get(&(s(card,"employeeCode").to_owned(),s(card,"date").to_owned())) {
                Some(old) if old==card => equal+=1,
                Some(_) => {changed+=1; differences.insert(s(card,"employeeCode").to_owned());},
                None => added+=1,
            }
        }
        eprintln!("BENCH {}",json!({"collectionMs":elapsed,"employeeCount":data["employees"].as_array().unwrap().len(),"timecardCount":records.len(),"comparedEqual":equal,"changedSincePublication":changed,"addedSincePublication":added,"previousCardCount":expected.len(),"collectionPeakRssKiB":collection_peak[0],"collectionPeakPssKiB":collection_peak[1],"collectionPeakPrivateKiB":collection_peak[2],"unreadableSmaps":collection_peak[3]}));

        // "1" keeps the original six-page probe; a larger number (or "all") covers
        // the roster so parity is measured rather than sampled.
        if let Ok(value) = std::env::var("DISPATCH_BENCHMARK_RESPONSE") {
            let samples = match value.as_str() {
                "1" => 6,
                "all" => usize::MAX,
                other => other.parse().map_err(|_| Error::new("benchmark_configuration_required", 400))?,
            };
            inspect_responses(&driver, &data, samples).await?;
        }

        if !differences.is_empty() {
            driver.new_page().await?;
            let from=s(&data,"from"); let to=s(&data,"to");
            let day=chrono::NaiveDate::parse_from_str(from,"%Y-%m-%d").map_err(|_|Error::new("invalid_period",409))?;
            let period=json!({"start":from,"end":to,"key":format!("{from}_{to}"),"dates":(0..14).map(|i|(day+chrono::Duration::days(i)).to_string()).collect::<Vec<_>>()});
            let mut confirmed=0;
            for code in &differences {
                let reference=reference_timecard(&driver,code,&period).await?;
                let actual=records.iter().filter(|card|s(card,"employeeCode")==code).cloned().collect::<Vec<_>>();
                ensure(actual==reference,"benchmark_reference_mismatch",409)?;
                confirmed+=1;
            }
            eprintln!("BENCH {}",json!({"changedEmployeesConfirmedBySequentialReads":confirmed}));
        }
        Ok(())
    }.await;
    sampler.abort();
    let exit = driver.browser.close().await;
    eprintln!(
        "BENCH {}",
        json!({"peakRssKiB":peak[0].load(Ordering::Relaxed),"peakPssKiB":peak[1].load(Ordering::Relaxed),"peakPrivateKiB":peak[2].load(Ordering::Relaxed),"unreadableSmaps":peak[3].load(Ordering::Relaxed),"supervisorReaped":exit.supervisor_reaped})
    );
    result
}

// Preserve the original serialized navigation/read path as an independent live
// reference. This exists only in the ignored operator benchmark, never runtime.
async fn reference_timecard(driver: &Driver, code: &str, period: &Value) -> Result<Vec<Value>> {
    let path = format!(
        "/v4/cl/web.php/timecard/index?firstrefno={code}&perioddates={}&formtype=SUMMARY&dispatch_timecards=1",
        s(period, "key")
    );
    let source = format!("{}{path}", driver.origin);
    driver.navigate(&path).await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        ensure(Instant::now() < deadline, "provider_timeout", 504)?;
        let frame = driver.frame().await?;
        if s(&frame,"url")==source && driver.evaluate("document.readyState==='complete'&&!!document.querySelector('#tbltimesheet')&&!!document.querySelector('#periodtotals')").await?==true {break;}
        ensure(
            driver.trusted(s(&frame, "url")),
            "authentication_failed",
            409,
        )?;
        sleep(Duration::from_millis(200)).await;
    }
    let config = json!({"employeeCode":code,"period":period,"sourceUrl":source});
    let record = driver
        .evaluate(&format!(
            "({})({config})",
            include_str!("timecard.js").trim().trim_end_matches(';')
        ))
        .await?;
    collection::project(&record, code)
}

// An explicit, read-only experiment. Raw HTML never leaves the authenticated
// browser; only validated records and aggregate structure reach this process.
// The detached document runs no provider scripts and is never inserted in a tab.
async fn inspect_responses(driver: &Driver, data: &Value, samples: usize) -> Result<()> {
    let from = s(data, "from");
    let to = s(data, "to");
    let day = chrono::NaiveDate::parse_from_str(from, "%Y-%m-%d")
        .map_err(|_| Error::new("invalid_period", 409))?;
    let period = json!({"start":from,"end":to,"key":format!("{from}_{to}"),"dates":(0..14).map(|i|(day+chrono::Duration::days(i)).to_string()).collect::<Vec<_>>()});
    let mut equal = 0;
    let mut validated = 0;
    let mut rejected = Vec::new();
    let started = Instant::now();
    for (index, employee) in data["employees"]
        .as_array()
        .unwrap()
        .iter()
        .take(samples)
        .enumerate()
    {
        let code = s(employee, "code");
        let fetched = Instant::now();
        let source = format!(
            "{}/v4/cl/web.php/timecard/index?firstrefno={code}&perioddates={}&formtype=SUMMARY&dispatch_timecards=1",
            driver.origin,
            s(&period, "key")
        );
        let config = json!({"employeeCode":code,"period":period,"sourceUrl":source});
        let extractor = include_str!("timecard.js").trim().trim_end_matches(';');
        driver.evaluate(&format!(r#"(()=>{{globalThis.dispatchProbe=null;(async()=>{{try{{
          let stage='fetch';
          const response=await fetch({source},{{credentials:'include',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)}});
          if(response.status!==200)throw 'status_'+response.status;
          if(!/^text\/html(?:;|$)/i.test(response.headers.get('content-type')||'')||!response.body)throw 'content_type';
          const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{{fatal:true}});let text='',size=0;
          for(;;){{const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2097152){{await reader.cancel();throw 'size';}}text+=decoder.decode(part.value,{{stream:true}});}}
          text+=decoder.decode();const document=new DOMParser().parseFromString(text,'text/html'),location={{href:{source}}};
          const result={{bytes:size,tablePresent:!!document.querySelector('#tbltimesheet'),rows:document.querySelectorAll('#tbltimesheet > tbody > tr').length,scripts:document.scripts.length,record:null}};
          try{{result.record=({extractor})({config});}}catch{{}}
          globalThis.dispatchProbe={{ok:true,value:result}};
        }}catch(error){{globalThis.dispatchProbe={{ok:false,reason:typeof error==='string'?error:String(error&&error.name||'error')}};}}}})();return true;}})()"#, source=json!(source))).await?;
        let deadline = Instant::now() + Duration::from_secs(35);
        let probe = loop {
            ensure(Instant::now() < deadline, "provider_timeout", 504)?;
            let probe = driver.evaluate("globalThis.dispatchProbe").await?;
            if !probe.is_null() {
                break probe;
            }
            sleep(Duration::from_millis(100)).await;
        };
        driver.evaluate("delete globalThis.dispatchProbe").await?;
        if probe["ok"] != true {
            eprintln!(
                "RESPONSE {}",
                json!({"ordinal":index+1,"ms":fetched.elapsed().as_millis(),"fetchFailed":probe["reason"]})
            );
            continue;
        }
        let value = &probe["value"];
        let actual = collection::project(&value["record"], code);
        let reference = data["timecards"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|card| s(card, "employeeCode") == code)
            .cloned()
            .collect::<Vec<_>>();
        if actual.is_ok() {
            validated += 1;
        }
        // Field names only: which parts of a card differ, never their values.
        let mut differs = std::collections::BTreeSet::new();
        if let Ok(cards) = &actual {
            for (card, expected) in cards.iter().zip(&reference) {
                for key in ["date", "hours", "status"] {
                    if card[key] != expected[key] {
                        differs.insert(key.to_owned());
                    }
                }
                let (a, b) = (card["punches"].as_array(), expected["punches"].as_array());
                match (a, b) {
                    (Some(a), Some(b)) if a.len() == b.len() => {
                        for (x, y) in a.iter().zip(b) {
                            for (field, value) in x.as_object().into_iter().flatten() {
                                if y[field] != *value {
                                    differs.insert(format!("punches.{field}"));
                                }
                            }
                        }
                    }
                    _ => {
                        differs.insert("punches.length".to_owned());
                    }
                }
            }
            if cards.len() != reference.len() {
                differs.insert("cards.length".to_owned());
            }
        }
        let failure = actual.as_ref().err().map(|error| error.code.clone());
        let matches = actual.is_ok_and(|cards| cards == reference);
        if matches {
            equal += 1;
        } else if rejected.len() < 4 {
            rejected.push(code.to_owned());
        }
        eprintln!(
            "RESPONSE {}",
            json!({"ordinal":index+1,"ms":fetched.elapsed().as_millis(),"bytes":value["bytes"],"tablePresent":value["tablePresent"],"rows":value["rows"],"scripts":value["scripts"],"validated":!value["record"].is_null(),"matchesRendered":matches,"differs":differs,"error":failure})
        );
        driver.page.collect_garbage().await?;
    }
    eprintln!(
        "RESPONSE {}",
        json!({"samples":samples.min(data["employees"].as_array().unwrap().len()),"validated":validated,"equal":equal,"elapsedMs":started.elapsed().as_millis()})
    );
    // Why detached extraction was rejected: on the rendered page, tally each punch
    // cell child's static signature against whether layout shows it. No values.
    for code in rejected {
        let path = format!(
            "/v4/cl/web.php/timecard/index?firstrefno={code}&perioddates={}&formtype=SUMMARY&dispatch_timecards=1",
            s(&period, "key")
        );
        driver.navigate(&path).await?;
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline
            && driver.evaluate("document.readyState==='complete'&&!!document.querySelector('#tbltimesheet')&&!!document.querySelector('#periodtotals')").await? != true
        {
            sleep(Duration::from_millis(200)).await;
        }
        let shape = driver.evaluate(r#"(()=>{const t=document.querySelector('#tbltimesheet');if(!t)return null;
          const heads=Array.from(t.querySelectorAll('thead [data-column]')).map(e=>e.getAttribute('data-column'));
          const time=/^(0?[1-9]|1[0-2]):[0-5][0-9] [AP]M$/,tally={};
          for(const row of t.querySelectorAll(':scope > tbody > tr'))for(const slot of ['i1','o1','i2','o2']){const cell=row.children[heads.indexOf(slot)];if(!cell)continue;
            const kids=Array.from(cell.children);if(kids.length<2)continue;
            for(const kid of kids){const text=(kid.textContent||'').replace(/\s+/g,' ').trim();
              const key=[kid.tagName.toLowerCase(),'.'+Array.from(kid.classList).sort().join('.'),kid.getAttribute('style')?'[style='+kid.getAttribute('style').replace(/\s+/g,'')+']':'',kid.hidden?'[hidden]':'',time.test(text)?'<time>':text?'<text>':'<empty>',(kid.offsetParent!==null&&kid.getClientRects().length>0)?'VISIBLE':'hidden'].join(' ');
              tally[key]=(tally[key]||0)+1;}}
          return tally;})()"#).await?;
        eprintln!("SHAPE {}", json!({"rendered":shape}));
    }
    Ok(())
}
