use napi_derive::napi;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct HeaderTiming {
    pub file: String,
    pub duration_ms: u32,
    pub percentage: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct TemplateTiming {
    pub template: String,
    pub duration_ms: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct FunctionTiming {
    pub name: String,
    pub duration_ms: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct TimeTraceSummaryNative {
    pub total_duration_ms: u32,
    pub slowest_headers: Vec<HeaderTiming>,
    pub slowest_templates: Vec<TemplateTiming>,
    pub slowest_functions: Vec<FunctionTiming>,
}

#[derive(Deserialize, Debug)]
struct TraceDump {
    #[serde(rename = "traceEvents")]
    trace_events: Option<Vec<RawEvent>>,
}

#[derive(Deserialize, Debug)]
struct RawEvent {
    name: Option<String>,
    ts: Option<f64>,
    dur: Option<f64>,
    tid: Option<u64>,
    args: Option<RawArgs>,
}

#[derive(Deserialize, Debug)]
struct RawArgs {
    detail: Option<String>,
}

pub fn parse_trace_events(json_content: &str) -> Result<TimeTraceSummaryNative, String> {
    let events: Vec<RawEvent> = if let Ok(dump) = serde_json::from_str::<TraceDump>(json_content) {
        dump.trace_events.unwrap_or_default()
    } else if let Ok(arr) = serde_json::from_str::<Vec<RawEvent>>(json_content) {
        arr
    } else {
        return Err("Invalid Chrome trace JSON format".to_string());
    };

    let mut total_duration_us: f64 = 0.0;
    let mut header_map: HashMap<String, f64> = HashMap::new();
    let mut template_map: HashMap<String, f64> = HashMap::new();
    let mut function_map: HashMap<String, f64> = HashMap::new();
    let mut source_events_by_thread: HashMap<u64, Vec<&RawEvent>> = HashMap::new();

    for event in &events {
        let name = event.name.as_deref().unwrap_or("");
        let dur = event.dur.unwrap_or(0.0);

        if (name == "Total ExecuteCompiler" || name == "ExecuteCompiler")
            && dur > total_duration_us {
                total_duration_us = dur;
            }

        if name == "Source" {
            if let Some(args) = &event.args {
                if args.detail.is_some() && dur > 0.0 {
                    let tid = event.tid.unwrap_or(0);
                    source_events_by_thread.entry(tid).or_default().push(event);
                }
            }
        } else if name == "InstantiateFunction" || name == "InstantiateClass" {
            let detail = event
                .args
                .as_ref()
                .and_then(|a| a.detail.clone())
                .unwrap_or_else(|| "anonymous_template".to_string());
            *template_map.entry(detail).or_default() += dur;
        } else if name == "OptFunction" || name == "CodeGen Function" {
            let detail = event
                .args
                .as_ref()
                .and_then(|a| a.detail.clone())
                .unwrap_or_else(|| "function".to_string());
            *function_map.entry(detail).or_default() += dur;
        }
    }

    // Calculate self-time for Source events using interval stack per thread
    for (_tid, mut thread_events) in source_events_by_thread {
        let all_have_ts = thread_events.iter().all(|e| e.ts.is_some());
        if !all_have_ts {
            for e in thread_events {
                if let Some(detail) = e.args.as_ref().and_then(|a| a.detail.as_deref()) {
                    *header_map.entry(detail.to_string()).or_default() += e.dur.unwrap_or(0.0);
                }
            }
            continue;
        }

        thread_events.sort_by(|a, b| {
            let ts_a = a.ts.unwrap_or(0.0);
            let ts_b = b.ts.unwrap_or(0.0);
            ts_a.partial_cmp(&ts_b)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    let dur_a = a.dur.unwrap_or(0.0);
                    let dur_b = b.dur.unwrap_or(0.0);
                    dur_b.partial_cmp(&dur_a).unwrap_or(std::cmp::Ordering::Equal)
                })
        });

        struct StackItem<'a> {
            file: &'a str,
            end_ts: f64,
            child_dur: f64,
            total_dur: f64,
        }

        let mut stack: Vec<StackItem> = Vec::new();

        for e in thread_events {
            let start = e.ts.unwrap_or(0.0);
            let dur = e.dur.unwrap_or(0.0);
            let end = start + dur;
            let file = e
                .args
                .as_ref()
                .and_then(|a| a.detail.as_deref())
                .unwrap_or("");

            while let Some(top) = stack.last() {
                if top.end_ts <= start {
                    let item = stack.pop().unwrap();
                    let self_time = (item.total_dur - item.child_dur).max(0.0);
                    *header_map.entry(item.file.to_string()).or_default() += self_time;
                } else {
                    break;
                }
            }

            if let Some(top) = stack.last_mut() {
                top.child_dur += dur;
            }

            stack.push(StackItem {
                file,
                end_ts: end,
                child_dur: 0.0,
                total_dur: dur,
            });
        }

        while let Some(item) = stack.pop() {
            let self_time = (item.total_dur - item.child_dur).max(0.0);
            *header_map.entry(item.file.to_string()).or_default() += self_time;
        }
    }

    if total_duration_us == 0.0 {
        for event in &events {
            let name = event.name.as_deref().unwrap_or("");
            if name == "Frontend" || name == "Backend" {
                total_duration_us += event.dur.unwrap_or(0.0);
            }
        }
    }
    if total_duration_us == 0.0 {
        total_duration_us = 1000.0;
    }

    let total_duration_ms = (total_duration_us / 1000.0).round() as u32;

    let mut slowest_headers: Vec<HeaderTiming> = header_map
        .into_iter()
        .map(|(file, dur)| {
            let ms = (dur / 1000.0).round() as u32;
            let pct = ((dur / total_duration_us) * 100.0).round().min(100.0) as u32;
            HeaderTiming {
                file,
                duration_ms: ms,
                percentage: pct,
            }
        })
        .collect();
    slowest_headers.sort_by_key(|b| std::cmp::Reverse(b.duration_ms));
    slowest_headers.truncate(10);

    let mut slowest_templates: Vec<TemplateTiming> = template_map
        .into_iter()
        .map(|(template, dur)| TemplateTiming {
            template,
            duration_ms: (dur / 1000.0).round() as u32,
        })
        .collect();
    slowest_templates.sort_by_key(|b| std::cmp::Reverse(b.duration_ms));
    slowest_templates.truncate(10);

    let mut slowest_functions: Vec<FunctionTiming> = function_map
        .into_iter()
        .map(|(name, dur)| FunctionTiming {
            name,
            duration_ms: (dur / 1000.0).round() as u32,
        })
        .collect();
    slowest_functions.sort_by_key(|b| std::cmp::Reverse(b.duration_ms));
    slowest_functions.truncate(10);

    Ok(TimeTraceSummaryNative {
        total_duration_ms,
        slowest_headers,
        slowest_templates,
        slowest_functions,
    })
}

#[napi]
pub fn parse_ftime_trace_content(content: String) -> napi::Result<TimeTraceSummaryNative> {
    parse_trace_events(&content).map_err(napi::Error::from_reason)
}

#[napi]
pub async fn parse_ftime_trace_file(file_path: String) -> napi::Result<TimeTraceSummaryNative> {
    tokio::task::spawn_blocking(move || {
        let content = fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read file {}: {}", file_path, e))?;
        parse_trace_events(&content)
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
    .map_err(napi::Error::from_reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ftime_trace_self_time() {
        let trace = r#"{
            "traceEvents": [
                { "name": "ExecuteCompiler", "ph": "X", "ts": 0, "dur": 1000000 },
                { "name": "Source", "ph": "X", "ts": 0, "dur": 1000000, "args": { "detail": "/src/main.cpp" } },
                { "name": "Source", "ph": "X", "ts": 100000, "dur": 400000, "args": { "detail": "/src/a.h" } },
                { "name": "Source", "ph": "X", "ts": 200000, "dur": 150000, "args": { "detail": "/src/b.h" } }
            ]
        }"#;

        let summary = parse_trace_events(trace).unwrap();
        assert_eq!(summary.total_duration_ms, 1000);

        let main = summary.slowest_headers.iter().find(|h| h.file == "/src/main.cpp").unwrap();
        let a = summary.slowest_headers.iter().find(|h| h.file == "/src/a.h").unwrap();
        let b = summary.slowest_headers.iter().find(|h| h.file == "/src/b.h").unwrap();

        assert_eq!(main.duration_ms, 600);
        assert_eq!(main.percentage, 60);

        assert_eq!(a.duration_ms, 250);
        assert_eq!(a.percentage, 25);

        assert_eq!(b.duration_ms, 150);
        assert_eq!(b.percentage, 15);
    }
}
