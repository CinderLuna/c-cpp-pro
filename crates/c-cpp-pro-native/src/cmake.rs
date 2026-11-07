use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct CMakeRawCommand {
    pub name: String,
    pub args: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CMakeTargetInfoNative {
    pub name: String,
    #[napi(js_name = "type")]
    #[serde(rename = "type")]
    pub target_type: String, // "executable" | "library" | "interface" | "custom"
    pub source_files: Vec<String>,
    pub include_directories: Vec<String>,
    pub compile_definitions: Vec<String>,
    pub linked_targets: Option<Vec<String>>,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CMakeProjectInfoNative {
    pub workspace_root: String,
    pub cmake_lists_path: String,
    pub include_directories: Vec<String>,
    pub global_include_directories: Option<Vec<String>>,
    pub compile_definitions: Vec<String>,
    pub global_compile_definitions: Option<Vec<String>>,
    pub cpp_standard: Option<String>,
    pub c_standard: Option<String>,
    pub targets: Vec<CMakeTargetInfoNative>,
    pub subdirectories: Vec<String>,
}

fn normalize_slash(p: &str) -> String {
    p.replace('\\', "/")
}

fn is_path_absolute(p: &str) -> bool {
    let p_norm = normalize_slash(p);
    let bytes = p_norm.as_bytes();
    if bytes.first() == Some(&b'/') {
        return true;
    }
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\') {
        return true;
    }
    if bytes.len() >= 2 && bytes[0] == b'/' && bytes[1] == b'/' {
        return true;
    }
    Path::new(&p_norm).is_absolute()
}

fn resolve_path(base_dir: &str, rel_path: &str) -> String {
    let rel_norm = normalize_slash(rel_path);
    if is_path_absolute(&rel_norm) {
        return rel_norm;
    }
    let base_norm = normalize_slash(base_dir);
    let mut parts: Vec<&str> = base_norm.split('/').filter(|s| !s.is_empty()).collect();
    for seg in rel_norm.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        } else if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg);
        }
    }
    let is_windows = base_norm.contains(':');
    if is_windows {
        parts.join("/")
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub fn tokenize_commands(content: &str) -> Vec<CMakeRawCommand> {
    let mut commands = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Skip whitespace
        while i < len && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= len {
            break;
        }

        // Skip comments
        if chars[i] == '#' {
            while i < len && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
            continue;
        }

        // Read command name
        let name_start = i;
        while i < len && (chars[i].is_alphanumeric() || chars[i] == '_') {
            i += 1;
        }
        let cmd_name: String = chars[name_start..i].iter().collect::<String>().trim().to_lowercase();
        if cmd_name.is_empty() {
            i += 1;
            continue;
        }

        // Skip whitespace between command name and '('
        while i < len && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= len || chars[i] != '(' {
            continue;
        }
        i += 1; // skip '('

        // Read arguments until matching ')'
        let mut args = Vec::new();
        let mut paren_depth = 1;
        let mut current_token = String::new();

        while i < len && paren_depth > 0 {
            let ch = chars[i];

            if ch == '#' {
                while i < len && chars[i] != '\n' && chars[i] != '\r' {
                    i += 1;
                }
                continue;
            }

            if ch == '"' {
                i += 1;
                let mut str_val = String::new();
                while i < len && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < len {
                        str_val.push(chars[i + 1]);
                        i += 2;
                    } else {
                        str_val.push(chars[i]);
                        i += 1;
                    }
                }
                if i < len {
                    i += 1; // skip closing '"'
                }
                if !current_token.is_empty() {
                    current_token.push_str(&format!("\"{}\"", str_val));
                } else {
                    current_token = str_val;
                }
                continue;
            }

            if ch == '(' {
                paren_depth += 1;
                current_token.push(ch);
                i += 1;
                continue;
            }

            if ch == ')' {
                paren_depth -= 1;
                if paren_depth == 0 {
                    let trimmed = current_token.trim().to_string();
                    if !trimmed.is_empty() {
                        args.push(trimmed);
                    }
                    current_token.clear();
                    i += 1;
                    break;
                } else {
                    current_token.push(ch);
                    i += 1;
                    continue;
                }
            }

            if ch.is_whitespace() {
                let trimmed = current_token.trim().to_string();
                if !trimmed.is_empty() {
                    args.push(trimmed);
                }
                current_token.clear();
                i += 1;
                continue;
            }

            current_token.push(ch);
            i += 1;
        }

        if !cmd_name.is_empty() {
            commands.push(CMakeRawCommand {
                name: cmd_name,
                args,
            });
        }
    }

    commands
}

#[derive(Default)]
pub struct ParsedCMakeFile {
    pub include_directories: Vec<String>,
    pub global_include_directories: Vec<String>,
    pub compile_definitions: Vec<String>,
    pub global_compile_definitions: Vec<String>,
    pub cpp_standard: Option<String>,
    pub c_standard: Option<String>,
    pub targets: Vec<CMakeTargetInfoNative>,
    pub subdirectories: Vec<String>,
}

pub fn resolve_variables(str_val: &str, variables: &HashMap<String, String>) -> String {
    let mut resolved = str_val.to_string();
    let mut prev = String::new();
    let mut loop_count = 0;

    while resolved != prev && loop_count < 5 {
        prev = resolved.clone();
        loop_count += 1;

        let mut output = String::new();
        let mut rest = &resolved[..];
        while let Some(start) = rest.find("${") {
            output.push_str(&rest[..start]);
            let var_rest = &rest[start + 2..];
            if let Some(end) = var_rest.find('}') {
                let var_name = &var_rest[..end];
                if let Some(val) = variables.get(var_name) {
                    output.push_str(val);
                }
                rest = &var_rest[end + 1..];
            } else {
                output.push_str(&rest[start..]);
                rest = "";
                break;
            }
        }
        output.push_str(rest);
        resolved = output;
    }

    resolved
}

pub fn parse_cmake_file_internal(
    file_path: &str,
    workspace_root: &str,
    inherited_variables: &HashMap<String, String>,
    visited_files: &mut HashSet<String>,
) -> ParsedCMakeFile {
    let norm_path = normalize_slash(file_path).to_lowercase();
    if visited_files.contains(&norm_path) {
        return ParsedCMakeFile::default();
    }
    visited_files.insert(norm_path);

    let mut result = ParsedCMakeFile::default();
    let content = match fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(_) => return result,
    };

    let p = Path::new(file_path);
    let current_dir = normalize_slash(&p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default());

    let mut variables = inherited_variables.clone();
    if !variables.contains_key("CMAKE_CURRENT_SOURCE_DIR") {
        variables.insert("CMAKE_CURRENT_SOURCE_DIR".to_string(), current_dir.clone());
    }
    variables.insert("CMAKE_CURRENT_LIST_DIR".to_string(), current_dir.clone());
    variables.insert("PROJECT_SOURCE_DIR".to_string(), workspace_root.to_string());
    variables.insert("CMAKE_SOURCE_DIR".to_string(), workspace_root.to_string());
    variables.insert("workspaceFolder".to_string(), workspace_root.to_string());

    let commands = tokenize_commands(&content);

    for cmd in commands {
        match cmd.name.as_str() {
            "set"
                if cmd.args.len() >= 2 => {
                    let var_name = cmd.args[0].clone();
                    let val_joined = cmd.args[1..].join(" ");
                    let resolved_val = resolve_variables(&val_joined, &variables);
                    variables.insert(var_name.clone(), resolved_val.clone());

                    if var_name == "CMAKE_CXX_STANDARD" {
                        let std = resolved_val.trim();
                        if std.chars().all(|c| c.is_ascii_digit()) {
                            result.cpp_standard = Some(format!("c++{}", std));
                        }
                    } else if var_name == "CMAKE_C_STANDARD" {
                        let std = resolved_val.trim();
                        if std.chars().all(|c| c.is_ascii_digit()) {
                            result.c_standard = Some(format!("c{}", std));
                        }
                    }
                }
            "include_directories" => {
                for arg in &cmd.args {
                    add_include(arg, &variables, &current_dir, None, &mut result);
                }
            }
            "target_include_directories"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for arg in &cmd.args[1..] {
                        add_include(arg, &variables, &current_dir, Some(target_idx), &mut result);
                    }
                }
            "add_definitions" => {
                for arg in &cmd.args {
                    add_define(arg, &variables, None, &mut result);
                }
            }
            "target_compile_definitions"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for arg in &cmd.args[1..] {
                        add_define(arg, &variables, Some(target_idx), &mut result);
                    }
                }
            "add_executable"
                if !cmd.args.is_empty() => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "executable", &mut result.targets);
                    result.targets[target_idx].target_type = "executable".to_string();

                    let is_alias_or_imported = cmd.args[1..].iter().any(|arg| {
                        let upper = arg.to_uppercase();
                        upper == "ALIAS" || upper == "IMPORTED"
                    });
                    if !is_alias_or_imported {
                        for s in &cmd.args[1..] {
                            let upper = s.to_uppercase();
                            if matches!(
                                upper.as_str(),
                                "WIN32" | "MACOSX_BUNDLE" | "EXCLUDE_FROM_ALL" | "ALIAS" | "IMPORTED" | "GLOBAL"
                            ) {
                                continue;
                            }
                            let res = resolve_variables(s, &variables);
                            let full = resolve_path(&current_dir, &res);
                            result.targets[target_idx].source_files.push(full);
                        }
                    }
                }
            "add_library"
                if !cmd.args.is_empty() => {
                    let target_name = &cmd.args[0];
                    let mut target_type = "library".to_string();
                    let mut src_start = 1;

                    if cmd.args.len() >= 2 {
                        let second = cmd.args[1].to_uppercase();
                        if matches!(second.as_str(), "STATIC" | "SHARED" | "MODULE" | "OBJECT") {
                            src_start = 2;
                        } else if second == "INTERFACE" {
                            target_type = "interface".to_string();
                            src_start = 2;
                        }
                    }

                    let target_idx = get_or_create_target(target_name, &target_type, &mut result.targets);
                    result.targets[target_idx].target_type = target_type;

                    let is_alias_or_imported = cmd.args[1..].iter().any(|arg| {
                        let upper = arg.to_uppercase();
                        upper == "ALIAS" || upper == "IMPORTED"
                    });
                    if is_alias_or_imported {
                        if cmd.args[1..].iter().any(|arg| arg.to_uppercase() == "INTERFACE") {
                            result.targets[target_idx].target_type = "interface".to_string();
                        }
                    } else {
                        for s in &cmd.args[src_start..] {
                            let upper = s.to_uppercase();
                            if matches!(
                                upper.as_str(),
                                "STATIC"
                                    | "SHARED"
                                    | "MODULE"
                                    | "OBJECT"
                                    | "INTERFACE"
                                    | "UNKNOWN"
                                    | "IMPORTED"
                                    | "ALIAS"
                                    | "GLOBAL"
                                    | "EXCLUDE_FROM_ALL"
                            ) {
                                continue;
                            }
                            let res = resolve_variables(s, &variables);
                            let full = resolve_path(&current_dir, &res);
                            result.targets[target_idx].source_files.push(full);
                        }
                    }
                }
            "target_sources"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for s in &cmd.args[1..] {
                        let upper = s.to_uppercase();
                        if matches!(upper.as_str(), "PUBLIC" | "PRIVATE" | "INTERFACE") {
                            continue;
                        }
                        let res = resolve_variables(s, &variables);
                        let full = resolve_path(&current_dir, &res);
                        result.targets[target_idx].source_files.push(full);
                    }
                }
            "target_link_libraries"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for arg in &cmd.args[1..] {
                        let res = resolve_variables(arg, &variables).trim().to_string();
                        let upper = res.to_uppercase();
                        if matches!(
                            upper.as_str(),
                            "PUBLIC"
                                | "PRIVATE"
                                | "INTERFACE"
                                | "LINK_PUBLIC"
                                | "LINK_PRIVATE"
                                | "DEBUG"
                                | "OPTIMIZED"
                                | "GENERAL"
                        ) {
                            continue;
                        }
                        if !res.is_empty() {
                            let list = result.targets[target_idx].linked_targets.get_or_insert_with(Vec::new);
                            if !list.contains(&res) {
                                list.push(res);
                            }
                        }
                    }
                }
            "add_subdirectory"
                if !cmd.args.is_empty() => {
                    let sub_name = resolve_variables(&cmd.args[0], &variables);
                    result.subdirectories.push(sub_name.clone());

                    let sub_dir = resolve_path(&current_dir, &sub_name);
                    let sub_cmake = format!("{}/CMakeLists.txt", sub_dir);

                    if Path::new(&sub_cmake).exists() {
                        let mut sub_vars = variables.clone();
                        sub_vars.insert("CMAKE_CURRENT_SOURCE_DIR".to_string(), sub_dir);
                        let sub_parsed = parse_cmake_file_internal(&sub_cmake, workspace_root, &sub_vars, visited_files);

                        for inc in sub_parsed.include_directories {
                            if !result.include_directories.contains(&inc) {
                                result.include_directories.push(inc);
                            }
                        }
                        for inc in sub_parsed.global_include_directories {
                            if !result.global_include_directories.contains(&inc) {
                                result.global_include_directories.push(inc);
                            }
                        }
                        for def in sub_parsed.compile_definitions {
                            if !result.compile_definitions.contains(&def) {
                                result.compile_definitions.push(def);
                            }
                        }
                        for def in sub_parsed.global_compile_definitions {
                            if !result.global_compile_definitions.contains(&def) {
                                result.global_compile_definitions.push(def);
                            }
                        }
                        for sub_t in sub_parsed.targets {
                            if let Some(existing) = result.targets.iter_mut().find(|t| t.name == sub_t.name) {
                                if existing.target_type == "custom" && sub_t.target_type != "custom" {
                                    existing.target_type = sub_t.target_type;
                                }
                                for s in sub_t.source_files {
                                    if !existing.source_files.contains(&s) {
                                        existing.source_files.push(s);
                                    }
                                }
                                for inc in sub_t.include_directories {
                                    if !existing.include_directories.contains(&inc) {
                                        existing.include_directories.push(inc);
                                    }
                                }
                                for def in sub_t.compile_definitions {
                                    if !existing.compile_definitions.contains(&def) {
                                        existing.compile_definitions.push(def);
                                    }
                                }
                                if let Some(sub_linked) = sub_t.linked_targets {
                                    let list = existing.linked_targets.get_or_insert_with(Vec::new);
                                    for lt in sub_linked {
                                        if !list.contains(&lt) {
                                            list.push(lt);
                                        }
                                    }
                                }
                            } else {
                                result.targets.push(sub_t);
                            }
                        }
                    }
                }
            "include"
                if !cmd.args.is_empty() => {
                    let file_arg = resolve_variables(&cmd.args[0], &variables);
                    let candidates = vec![
                        resolve_path(&current_dir, &file_arg),
                        resolve_path(&current_dir, &format!("{}.cmake", file_arg)),
                        resolve_path(workspace_root, &format!("cmake/{}", file_arg)),
                        resolve_path(workspace_root, &format!("cmake/{}.cmake", file_arg)),
                    ];

                    for cand in candidates {
                        if Path::new(&cand).is_file() {
                            let inc_parsed = parse_cmake_file_internal(&cand, workspace_root, &variables, visited_files);
                            for inc in inc_parsed.include_directories {
                                if !result.include_directories.contains(&inc) {
                                    result.include_directories.push(inc);
                                }
                            }
                            for inc in inc_parsed.global_include_directories {
                                if !result.global_include_directories.contains(&inc) {
                                    result.global_include_directories.push(inc);
                                }
                            }
                            for def in inc_parsed.compile_definitions {
                                if !result.compile_definitions.contains(&def) {
                                    result.compile_definitions.push(def);
                                }
                            }
                            for def in inc_parsed.global_compile_definitions {
                                if !result.global_compile_definitions.contains(&def) {
                                    result.global_compile_definitions.push(def);
                                }
                            }
                            break;
                        }
                    }
                }
            _ => {}
        }
    }

    resolve_linked_target_properties(
        &mut result.targets,
        &mut result.include_directories,
        &mut result.compile_definitions,
    );

    result
}

pub fn resolve_linked_target_properties(
    targets: &mut [CMakeTargetInfoNative],
    global_includes: &mut Vec<String>,
    global_defs: &mut Vec<String>,
) {
    let mut changed = true;
    let mut passes = 0;
    while changed && passes < 20 {
        changed = false;
        passes += 1;
        let n = targets.len();
        for i in 0..n {
            let deps = match &targets[i].linked_targets {
                Some(d) => d.clone(),
                None => continue,
            };
            for dep_name in deps {
                if let Some(dep_idx) = targets.iter().position(|t| t.name == dep_name) {
                    let dep_incs = targets[dep_idx].include_directories.clone();
                    let dep_defs = targets[dep_idx].compile_definitions.clone();

                    for inc in dep_incs {
                        if !targets[i].include_directories.contains(&inc) {
                            targets[i].include_directories.push(inc.clone());
                            if !global_includes.contains(&inc) {
                                global_includes.push(inc);
                            }
                            changed = true;
                        }
                    }
                    for def in dep_defs {
                        if !targets[i].compile_definitions.contains(&def) {
                            targets[i].compile_definitions.push(def.clone());
                            if !global_defs.contains(&def) {
                                global_defs.push(def);
                            }
                            changed = true;
                        }
                    }
                }
            }
        }
    }
}

fn get_or_create_target(target_name: &str, default_type: &str, targets: &mut Vec<CMakeTargetInfoNative>) -> usize {
    if let Some(pos) = targets.iter().position(|t| t.name == target_name) {
        pos
    } else {
        targets.push(CMakeTargetInfoNative {
            name: target_name.to_string(),
            target_type: default_type.to_string(),
            source_files: Vec::new(),
            include_directories: Vec::new(),
            compile_definitions: Vec::new(),
            linked_targets: Some(Vec::new()),
        });
        targets.len() - 1
    }
}

fn add_include(
    raw_path: &str,
    variables: &HashMap<String, String>,
    current_dir: &str,
    target_idx: Option<usize>,
    result: &mut ParsedCMakeFile,
) {
    let mut candidate = raw_path.trim().to_string();
    if let Some(start) = candidate.find("$<BUILD_INTERFACE:") {
        let rest = &candidate[start + 18..];
        if let Some(end) = rest.find('>') {
            candidate = rest[..end].trim().to_string();
        }
    } else if candidate.contains("$<INSTALL_INTERFACE:") {
        return;
    }

    let resolved = resolve_variables(&candidate, variables).trim().to_string();
    if resolved.is_empty() || resolved.starts_with('$') || resolved.contains('<') || resolved.contains('>') {
        return;
    }

    let upper = resolved.to_uppercase();
    if matches!(upper.as_str(), "PUBLIC" | "PRIVATE" | "INTERFACE" | "SYSTEM" | "BEFORE" | "AFTER") {
        return;
    }

    let current_source_dir = variables
        .get("CMAKE_CURRENT_SOURCE_DIR")
        .map(|s| s.as_str())
        .unwrap_or(current_dir);
    let full = resolve_path(current_source_dir, &resolved);

    if !result.include_directories.contains(&full) {
        result.include_directories.push(full.clone());
    }
    match target_idx {
        None => {
            if !result.global_include_directories.contains(&full) {
                result.global_include_directories.push(full);
            }
        }
        Some(idx) => {
            if !result.targets[idx].include_directories.contains(&full) {
                result.targets[idx].include_directories.push(full);
            }
        }
    }
}

fn add_define(
    raw_def: &str,
    variables: &HashMap<String, String>,
    target_idx: Option<usize>,
    result: &mut ParsedCMakeFile,
) {
    let mut resolved = resolve_variables(raw_def, variables).trim().to_string();
    if resolved.is_empty() || resolved.starts_with('$') {
        return;
    }

    let upper = resolved.to_uppercase();
    if matches!(upper.as_str(), "PUBLIC" | "PRIVATE" | "INTERFACE") {
        return;
    }

    if resolved.starts_with("-D") {
        resolved = resolved[2..].to_string();
    }

    if !result.compile_definitions.contains(&resolved) {
        result.compile_definitions.push(resolved.clone());
    }
    match target_idx {
        None => {
            if !result.global_compile_definitions.contains(&resolved) {
                result.global_compile_definitions.push(resolved);
            }
        }
        Some(idx) => {
            if !result.targets[idx].compile_definitions.contains(&resolved) {
                result.targets[idx].compile_definitions.push(resolved);
            }
        }
    }
}

#[napi]
pub fn parse_cmake_content_native(
    content: String,
    cmake_lists_path: String,
    workspace_root: String,
) -> Result<CMakeProjectInfoNative, napi::Error> {
    let commands = tokenize_commands(&content);
    let p = Path::new(&cmake_lists_path);
    let current_dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();

    let mut variables = HashMap::new();
    variables.insert("CMAKE_CURRENT_SOURCE_DIR".to_string(), current_dir.clone());
    variables.insert("CMAKE_CURRENT_LIST_DIR".to_string(), current_dir.clone());
    variables.insert("PROJECT_SOURCE_DIR".to_string(), workspace_root.clone());
    variables.insert("CMAKE_SOURCE_DIR".to_string(), workspace_root.clone());
    variables.insert("workspaceFolder".to_string(), workspace_root.clone());

    let mut result = ParsedCMakeFile::default();

    for cmd in commands {
        match cmd.name.as_str() {
            "set"
                if cmd.args.len() >= 2 => {
                    let var_name = cmd.args[0].clone();
                    let val_joined = cmd.args[1..].join(" ");
                    let resolved_val = resolve_variables(&val_joined, &variables);
                    variables.insert(var_name.clone(), resolved_val.clone());

                    if var_name == "CMAKE_CXX_STANDARD" {
                        let std = resolved_val.trim();
                        if std.chars().all(|c| c.is_ascii_digit()) {
                            result.cpp_standard = Some(format!("c++{}", std));
                        }
                    } else if var_name == "CMAKE_C_STANDARD" {
                        let std = resolved_val.trim();
                        if std.chars().all(|c| c.is_ascii_digit()) {
                            result.c_standard = Some(format!("c{}", std));
                        }
                    }
                }
            "include_directories" => {
                for arg in &cmd.args {
                    add_include(arg, &variables, &current_dir, None, &mut result);
                }
            }
            "target_include_directories"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for arg in &cmd.args[1..] {
                        add_include(arg, &variables, &current_dir, Some(target_idx), &mut result);
                    }
                }
            "add_definitions" => {
                for arg in &cmd.args {
                    add_define(arg, &variables, None, &mut result);
                }
            }
            "target_compile_definitions"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for arg in &cmd.args[1..] {
                        add_define(arg, &variables, Some(target_idx), &mut result);
                    }
                }
            "add_executable"
                if !cmd.args.is_empty() => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "executable", &mut result.targets);
                    result.targets[target_idx].target_type = "executable".to_string();

                    let is_alias_or_imported = cmd.args[1..].iter().any(|arg| {
                        let upper = arg.to_uppercase();
                        upper == "ALIAS" || upper == "IMPORTED"
                    });
                    if !is_alias_or_imported {
                        for s in &cmd.args[1..] {
                            let upper = s.to_uppercase();
                            if matches!(
                                upper.as_str(),
                                "WIN32" | "MACOSX_BUNDLE" | "EXCLUDE_FROM_ALL" | "ALIAS" | "IMPORTED" | "GLOBAL"
                            ) {
                                continue;
                            }
                            let res = resolve_variables(s, &variables);
                            let full = resolve_path(&current_dir, &res);
                            result.targets[target_idx].source_files.push(full);
                        }
                    }
                }
            "add_library"
                if !cmd.args.is_empty() => {
                    let target_name = &cmd.args[0];
                    let mut target_type = "library".to_string();
                    let mut src_start = 1;

                    if cmd.args.len() >= 2 {
                        let second = cmd.args[1].to_uppercase();
                        if matches!(second.as_str(), "STATIC" | "SHARED" | "MODULE" | "OBJECT") {
                            src_start = 2;
                        } else if second == "INTERFACE" {
                            target_type = "interface".to_string();
                            src_start = 2;
                        }
                    }

                    let target_idx = get_or_create_target(target_name, &target_type, &mut result.targets);
                    result.targets[target_idx].target_type = target_type;

                    let is_alias_or_imported = cmd.args[1..].iter().any(|arg| {
                        let upper = arg.to_uppercase();
                        upper == "ALIAS" || upper == "IMPORTED"
                    });
                    if is_alias_or_imported {
                        if cmd.args[1..].iter().any(|arg| arg.to_uppercase() == "INTERFACE") {
                            result.targets[target_idx].target_type = "interface".to_string();
                        }
                    } else {
                        for s in &cmd.args[src_start..] {
                            let upper = s.to_uppercase();
                            if matches!(
                                upper.as_str(),
                                "STATIC"
                                    | "SHARED"
                                    | "MODULE"
                                    | "OBJECT"
                                    | "INTERFACE"
                                    | "UNKNOWN"
                                    | "IMPORTED"
                                    | "ALIAS"
                                    | "GLOBAL"
                                    | "EXCLUDE_FROM_ALL"
                            ) {
                                continue;
                            }
                            let res = resolve_variables(s, &variables);
                            let full = resolve_path(&current_dir, &res);
                            result.targets[target_idx].source_files.push(full);
                        }
                    }
                }
            "target_sources"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for s in &cmd.args[1..] {
                        let upper = s.to_uppercase();
                        if matches!(upper.as_str(), "PUBLIC" | "PRIVATE" | "INTERFACE") {
                            continue;
                        }
                        let res = resolve_variables(s, &variables);
                        let full = resolve_path(&current_dir, &res);
                        result.targets[target_idx].source_files.push(full);
                    }
                }
            "target_link_libraries"
                if cmd.args.len() >= 2 => {
                    let target_name = &cmd.args[0];
                    let target_idx = get_or_create_target(target_name, "custom", &mut result.targets);
                    for arg in &cmd.args[1..] {
                        let res = resolve_variables(arg, &variables).trim().to_string();
                        let upper = res.to_uppercase();
                        if matches!(
                            upper.as_str(),
                            "PUBLIC"
                                | "PRIVATE"
                                | "INTERFACE"
                                | "LINK_PUBLIC"
                                | "LINK_PRIVATE"
                                | "DEBUG"
                                | "OPTIMIZED"
                                | "GENERAL"
                        ) {
                            continue;
                        }
                        if !res.is_empty() {
                            let list = result.targets[target_idx].linked_targets.get_or_insert_with(Vec::new);
                            if !list.contains(&res) {
                                list.push(res);
                            }
                        }
                    }
                }
            _ => {}
        }
    }

    resolve_linked_target_properties(
        &mut result.targets,
        &mut result.include_directories,
        &mut result.compile_definitions,
    );

    Ok(CMakeProjectInfoNative {
        workspace_root,
        cmake_lists_path,
        include_directories: result.include_directories,
        global_include_directories: Some(result.global_include_directories),
        compile_definitions: result.compile_definitions,
        global_compile_definitions: Some(result.global_compile_definitions),
        cpp_standard: result.cpp_standard,
        c_standard: result.c_standard,
        targets: result.targets,
        subdirectories: result.subdirectories,
    })
}

#[napi]
pub fn parse_cmake_workspace_native(workspace_root: String) -> Result<Option<CMakeProjectInfoNative>, napi::Error> {
    let root_cmake = format!("{}/CMakeLists.txt", normalize_slash(&workspace_root));
    if !Path::new(&root_cmake).exists() {
        return Ok(None);
    }

    let mut visited = HashSet::new();
    let variables = HashMap::new();
    let mut parsed = parse_cmake_file_internal(&root_cmake, &workspace_root, &variables, &mut visited);

    resolve_linked_target_properties(
        &mut parsed.targets,
        &mut parsed.include_directories,
        &mut parsed.compile_definitions,
    );

    Ok(Some(CMakeProjectInfoNative {
        workspace_root: workspace_root.clone(),
        cmake_lists_path: root_cmake,
        include_directories: parsed.include_directories,
        global_include_directories: Some(parsed.global_include_directories),
        compile_definitions: parsed.compile_definitions,
        global_compile_definitions: Some(parsed.global_compile_definitions),
        cpp_standard: parsed.cpp_standard,
        c_standard: parsed.c_standard,
        targets: parsed.targets,
        subdirectories: parsed.subdirectories,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_cmake_commands() {
        let content = r#"
            cmake_minimum_required(VERSION 3.20)
            set(CMAKE_CXX_STANDARD 20)
            # A test comment
            add_executable(MyGame src/main.cpp "src/engine core.cpp")
            target_include_directories(MyGame PRIVATE include $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/extra>)
            target_compile_definitions(MyGame PUBLIC -DDEBUG_MODE=1)
        "#;

        let commands = tokenize_commands(content);
        assert_eq!(commands.len(), 5);
        assert_eq!(commands[0].name, "cmake_minimum_required");
        assert_eq!(commands[1].name, "set");
        assert_eq!(commands[2].name, "add_executable");
        assert_eq!(commands[2].args, vec!["MyGame", "src/main.cpp", "src/engine core.cpp"]);
        assert_eq!(commands[3].name, "target_include_directories");
        assert_eq!(commands[4].name, "target_compile_definitions");
    }

    #[test]
    fn test_parse_cmake_content_native() {
        let content = r#"
            set(CMAKE_CXX_STANDARD 20)
            set(MY_INC include)
            add_executable(App src/main.cpp)
            target_include_directories(App PRIVATE ${MY_INC} $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/internal>)
            target_compile_definitions(App PRIVATE -DENABLE_VULKAN)
        "#;

        let proj = parse_cmake_content_native(
            content.to_string(),
            "C:/my_project/CMakeLists.txt".to_string(),
            "C:/my_project".to_string(),
        ).unwrap();

        assert_eq!(proj.cpp_standard, Some("c++20".to_string()));
        assert_eq!(proj.targets.len(), 1);
        assert_eq!(proj.targets[0].name, "App");
        assert_eq!(proj.targets[0].target_type, "executable");
        assert_eq!(proj.targets[0].source_files, vec!["C:/my_project/src/main.cpp"]);
        assert_eq!(proj.targets[0].include_directories, vec![
            "C:/my_project/include",
            "C:/my_project/internal"
        ]);
        assert_eq!(proj.targets[0].compile_definitions, vec!["ENABLE_VULKAN"]);
    }
}
