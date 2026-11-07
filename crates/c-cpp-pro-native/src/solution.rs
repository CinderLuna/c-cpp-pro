use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SolutionConfigurationNative {
    pub configuration: String,
    pub platform: String,
    pub key: String,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SolutionProjectEntryNative {
    pub name: String,
    pub relative_path: String,
    pub full_path: String,
    pub guid: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SolutionModelNative {
    pub format: String,
    pub file_path: String,
    pub name: String,
    pub configurations: Vec<SolutionConfigurationNative>,
    pub projects: Vec<SolutionProjectEntryNative>,
}

#[napi(object)]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProjectCompileOptionsNative {
    pub include_directories: Vec<String>,
    pub preprocessor_definitions: Vec<String>,
    pub language_standard: String,
    pub additional_options: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VcxProjectModelNative {
    pub file_path: String,
    pub name: String,
    pub guid: Option<String>,
    pub configuration_type: String,
    pub configurations: Vec<SolutionConfigurationNative>,
    pub compile_options_by_config: HashMap<String, ProjectCompileOptionsNative>,
    pub default_compile_options: ProjectCompileOptionsNative,
    pub source_files: Vec<String>,
    pub header_files: Vec<String>,
    pub target_name: Option<String>,
    pub out_dir: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompileCommandEntryNative {
    pub directory: String,
    pub command: String,
    pub arguments: Option<Vec<String>>,
    pub file: String,
}

pub fn normalize_language_standard(std: Option<&str>) -> String {
    let lower = std.unwrap_or("").to_lowercase();
    if lower.contains("latest") || lower.contains("23") {
        "c++23".to_string()
    } else if lower.contains("20") {
        "c++20".to_string()
    } else if lower.contains("17") {
        "c++17".to_string()
    } else if lower.contains("14") {
        "c++14".to_string()
    } else {
        "c++20".to_string()
    }
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

#[napi]
pub fn parse_sln_content_native(content: String, file_path: String) -> Result<SolutionModelNative, napi::Error> {
    let path_obj = Path::new(&file_path);
    let solution_dir = path_obj.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let solution_name = path_obj
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut projects = Vec::new();
    let mut configurations = Vec::new();

    // Parse Project(...) = "Name", "RelPath.vcxproj", "{GUID}"
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Project(") && trimmed.contains('\"') {
            let parts: Vec<&str> = trimmed.split('=').collect();
            if parts.len() >= 2 {
                let val_part = parts[1].trim();
                let mut quoted_strings = Vec::new();
                let mut in_quote = false;
                let mut current = String::new();
                for c in val_part.chars() {
                    if c == '"' {
                        if in_quote {
                            quoted_strings.push(current.clone());
                            current.clear();
                            in_quote = false;
                        } else {
                            in_quote = true;
                        }
                    } else if in_quote {
                        current.push(c);
                    }
                }

                if quoted_strings.len() >= 2 {
                    let name = quoted_strings[0].trim().to_string();
                    let rel_path = normalize_slash(quoted_strings[1].trim());
                    let guid = quoted_strings.get(2).map(|s| s.trim().to_string());

                    if rel_path.to_lowercase().ends_with(".vcxproj") {
                        let full_path = resolve_path(&solution_dir, &rel_path);
                        projects.push(SolutionProjectEntryNative {
                            name,
                            relative_path: rel_path,
                            full_path,
                            guid,
                        });
                    }
                }
            }
        }
    }

    // Parse SolutionConfigurationPlatforms
    if let Some(start_idx) = content.find("GlobalSection(SolutionConfigurationPlatforms)") {
        if let Some(end_idx) = content[start_idx..].find("EndGlobalSection") {
            let section = &content[start_idx..start_idx + end_idx];
            for line in section.lines() {
                let trimmed = line.trim();
                if trimmed.contains('=') && !trimmed.starts_with("GlobalSection") {
                    let key = trimmed.split('=').next().unwrap_or("").trim();
                    let parts: Vec<&str> = key.split('|').collect();
                    if parts.len() == 2 {
                        configurations.push(SolutionConfigurationNative {
                            configuration: parts[0].trim().to_string(),
                            platform: parts[1].trim().to_string(),
                            key: key.to_string(),
                        });
                    }
                }
            }
        }
    }

    if configurations.is_empty() {
        configurations.push(SolutionConfigurationNative {
            configuration: "Debug".to_string(),
            platform: "x64".to_string(),
            key: "Debug|x64".to_string(),
        });
        configurations.push(SolutionConfigurationNative {
            configuration: "Release".to_string(),
            platform: "x64".to_string(),
            key: "Release|x64".to_string(),
        });
    }

    Ok(SolutionModelNative {
        format: "sln".to_string(),
        file_path,
        name: solution_name,
        configurations,
        projects,
    })
}

#[napi]
pub fn parse_slnx_content_native(content: String, file_path: String) -> Result<SolutionModelNative, napi::Error> {
    let path_obj = Path::new(&file_path);
    let solution_dir = path_obj.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let solution_name = path_obj
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut projects = Vec::new();
    let mut configurations = Vec::new();

    // Fast regex/token extraction
    let mut config_names = Vec::new();
    let mut platform_names = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<Configuration") {
            if let Some(name_pos) = trimmed.find("Name=\"") {
                let rest = &trimmed[name_pos + 6..];
                if let Some(end_quote) = rest.find('\"') {
                    config_names.push(rest[..end_quote].to_string());
                }
            } else if let Some(sol_pos) = trimmed.find("Solution=\"") {
                let rest = &trimmed[sol_pos + 10..];
                if let Some(end_quote) = rest.find('\"') {
                    let key = &rest[..end_quote];
                    let parts: Vec<&str> = key.split('|').collect();
                    if parts.len() == 2 && !configurations.iter().any(|c: &SolutionConfigurationNative| c.key == key) {
                        configurations.push(SolutionConfigurationNative {
                            configuration: parts[0].to_string(),
                            platform: parts[1].to_string(),
                            key: key.to_string(),
                        });
                    }
                }
            }
        } else if trimmed.starts_with("<Platform") {
            if let Some(name_pos) = trimmed.find("Name=\"") {
                let rest = &trimmed[name_pos + 6..];
                if let Some(end_quote) = rest.find('\"') {
                    platform_names.push(rest[..end_quote].to_string());
                }
            }
        } else if trimmed.starts_with("<Project") {
            if let Some(path_pos) = trimmed.find("Path=\"") {
                let rest = &trimmed[path_pos + 6..];
                if let Some(end_quote) = rest.find('\"') {
                    let rel_path = normalize_slash(&rest[..end_quote]);
                    if rel_path.to_lowercase().ends_with(".vcxproj") {
                        let id = if let Some(id_pos) = trimmed.find("Id=\"") {
                            let id_rest = &trimmed[id_pos + 4..];
                            id_rest.find('\"').map(|eq| id_rest[..eq].to_string())
                        } else {
                            None
                        };
                        let name = Path::new(&rel_path)
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let full_path = resolve_path(&solution_dir, &rel_path);
                        projects.push(SolutionProjectEntryNative {
                            name,
                            relative_path: rel_path,
                            full_path,
                            guid: id,
                        });
                    }
                }
            }
        }
    }

    if !config_names.is_empty() && !platform_names.is_empty() {
        for conf in &config_names {
            for plat in &platform_names {
                let key = format!("{}|{}", conf, plat);
                if !configurations.iter().any(|c| c.key == key) {
                    configurations.push(SolutionConfigurationNative {
                        configuration: conf.clone(),
                        platform: plat.clone(),
                        key,
                    });
                }
            }
        }
    }

    if configurations.is_empty() {
        configurations.push(SolutionConfigurationNative {
            configuration: "Debug".to_string(),
            platform: "x64".to_string(),
            key: "Debug|x64".to_string(),
        });
        configurations.push(SolutionConfigurationNative {
            configuration: "Release".to_string(),
            platform: "x64".to_string(),
            key: "Release|x64".to_string(),
        });
    }

    Ok(SolutionModelNative {
        format: "slnx".to_string(),
        file_path,
        name: solution_name,
        configurations,
        projects,
    })
}

#[napi]
pub fn parse_vcxproj_content_native(
    content: String,
    file_path: String,
    solution_dir: Option<String>,
) -> Result<VcxProjectModelNative, napi::Error> {
    let p = Path::new(&file_path);
    let project_dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
    let effective_solution_dir = solution_dir.unwrap_or_else(|| {
        Path::new(&project_dir)
            .parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|| project_dir.clone())
    });
    let project_name = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut guid = None;
    let mut configuration_type = "Application".to_string();
    let mut target_name = Some(project_name.clone());
    let mut out_dir = None;
    let mut configurations = Vec::new();
    let mut source_files = Vec::new();
    let mut header_files = Vec::new();
    let mut compile_options_by_config = HashMap::new();
    let mut default_compile_options = ProjectCompileOptionsNative {
        include_directories: Vec::new(),
        preprocessor_definitions: Vec::new(),
        language_standard: "c++20".to_string(),
        additional_options: Vec::new(),
    };

    // Extract ProjectGuid
    if let Some(start) = content.find("<ProjectGuid>") {
        if let Some(end) = content[start..].find("</ProjectGuid>") {
            guid = Some(content[start + 13..start + end].trim().to_string());
        }
    }

    // Extract ConfigurationType
    if let Some(start) = content.find("<ConfigurationType>") {
        if let Some(end) = content[start..].find("</ConfigurationType>") {
            configuration_type = content[start + 19..start + end].trim().to_string();
        }
    }

    // Extract TargetName
    if let Some(start) = content.find("<TargetName>") {
        if let Some(end) = content[start..].find("</TargetName>") {
            target_name = Some(content[start + 12..start + end].trim().to_string());
        }
    }

    // Extract OutDir
    if let Some(start) = content.find("<OutDir>") {
        if let Some(end) = content[start..].find("</OutDir>") {
            let raw = content[start + 8..start + end].trim();
            let expanded = raw
                .replace("$(ProjectDir)", &(normalize_slash(&project_dir) + "/"))
                .replace("$(SolutionDir)", &(normalize_slash(&effective_solution_dir) + "/"));
            out_dir = Some(expanded);
        }
    }

    // Parse ProjectConfigurations
    let mut rest = &content[..];
    while let Some(start) = rest.find("<ProjectConfiguration") {
        rest = &rest[start..];
        let end_tag = rest.find("</ProjectConfiguration>").unwrap_or(rest.len());
        let chunk = &rest[..end_tag];
        if let Some(inc_start) = chunk.find("Include=\"") {
            let inc_rest = &chunk[inc_start + 9..];
            if let Some(inc_end) = inc_rest.find('\"') {
                let key = inc_rest[..inc_end].trim().to_string();
                let conf = if let Some(cs) = chunk.find("<Configuration>") {
                    chunk[cs..].find("</Configuration>").map(|ce| chunk[cs + 15..cs + ce].trim().to_string()).unwrap_or_default()
                } else {
                    String::new()
                };
                let plat = if let Some(ps) = chunk.find("<Platform>") {
                    chunk[ps..].find("</Platform>").map(|pe| chunk[ps + 10..ps + pe].trim().to_string()).unwrap_or_default()
                } else {
                    String::new()
                };
                configurations.push(SolutionConfigurationNative {
                    key,
                    configuration: conf,
                    platform: plat,
                });
            }
        }
        rest = &rest[end_tag..];
    }

    // ClCompile sources
    let mut cl_rest = &content[..];
    const CL_COMPILE_TAG: &str = "<ClCompile Include=\"";
    while let Some(idx) = cl_rest.find(CL_COMPILE_TAG) {
        cl_rest = &cl_rest[idx + CL_COMPILE_TAG.len()..];
        if let Some(q_end) = cl_rest.find('\"') {
            let raw_file = cl_rest[..q_end].trim();
            if !raw_file.is_empty() {
                let full = resolve_path(&project_dir, raw_file);
                if !source_files.contains(&full) {
                    source_files.push(full);
                }
            }
            cl_rest = &cl_rest[q_end..];
        }
    }

    // ClInclude headers
    let mut h_rest = &content[..];
    const CL_INCLUDE_TAG: &str = "<ClInclude Include=\"";
    while let Some(idx) = h_rest.find(CL_INCLUDE_TAG) {
        h_rest = &h_rest[idx + CL_INCLUDE_TAG.len()..];
        if let Some(q_end) = h_rest.find('\"') {
            let raw_file = h_rest[..q_end].trim();
            if !raw_file.is_empty() {
                let full = resolve_path(&project_dir, raw_file);
                if !header_files.contains(&full) {
                    header_files.push(full);
                }
            }
            h_rest = &h_rest[q_end..];
        }
    }

    // Parse ItemDefinitionGroup
    let mut id_rest = &content[..];
    while let Some(start) = id_rest.find("<ItemDefinitionGroup") {
        id_rest = &id_rest[start..];
        let end_group = id_rest.find("</ItemDefinitionGroup>").unwrap_or(id_rest.len());
        let chunk = &id_rest[..end_group];

        let condition = if let Some(tag_end) = chunk.find('>') {
            let open_tag = &chunk[..tag_end];
            if let Some(cond_pos) = open_tag.find("Condition=\"") {
                let rest_cond = &open_tag[cond_pos + 11..];
                rest_cond.find('\"').map(|e| rest_cond[..e].trim())
            } else {
                None
            }
        } else {
            None
        };

        if let Some(cl_start) = chunk.find("<ClCompile>") {
            if let Some(cl_end) = chunk[cl_start..].find("</ClCompile>") {
                let cl_body = &chunk[cl_start + 11..cl_start + cl_end];

                // Standard
                let lang_std = if let Some(s) = cl_body.find("<LanguageStandard>") {
                    cl_body[s..].find("</LanguageStandard>").map(|e| &cl_body[s + 18..s + e])
                } else {
                    None
                };
                let std = normalize_language_standard(lang_std);

                // Include dirs
                let mut include_dirs = Vec::new();
                if let Some(s) = cl_body.find("<AdditionalIncludeDirectories>") {
                    if let Some(e) = cl_body[s..].find("</AdditionalIncludeDirectories>") {
                        let raw_incs = &cl_body[s + 30..s + e];
                        for inc in raw_incs.split(';') {
                            let mut trimmed = inc.trim();
                            if trimmed.is_empty() || trimmed.contains("%(AdditionalIncludeDirectories)") {
                                continue;
                            }
                            if trimmed.starts_with('\"') && trimmed.ends_with('\"') && trimmed.len() >= 2 {
                                trimmed = trimmed[1..trimmed.len() - 1].trim();
                            }
                            let expanded = trimmed
                                .replace("$(ProjectDir)", &(normalize_slash(&project_dir) + "/"))
                                .replace("$(SolutionDir)", &(normalize_slash(&effective_solution_dir) + "/"));
                            let full = resolve_path(&project_dir, &expanded);
                            if !include_dirs.contains(&full) {
                                include_dirs.push(full);
                            }
                        }
                    }
                }

                // Preprocessor definitions
                let mut preproc_defs = Vec::new();
                if let Some(s) = cl_body.find("<PreprocessorDefinitions>") {
                    if let Some(e) = cl_body[s..].find("</PreprocessorDefinitions>") {
                        let raw_defs = &cl_body[s + 25..s + e];
                        for def in raw_defs.split(';') {
                            let trimmed = def.trim();
                            if trimmed.is_empty() || trimmed.contains("%(PreprocessorDefinitions)") {
                                continue;
                            }
                            preproc_defs.push(trimmed.to_string());
                        }
                    }
                }

                // Additional options
                let mut additional_options = Vec::new();
                if let Some(s) = cl_body.find("<AdditionalOptions>") {
                    if let Some(e) = cl_body[s..].find("</AdditionalOptions>") {
                        let raw_opts = &cl_body[s + 19..s + e];
                        for opt in raw_opts.split_whitespace() {
                            if opt.is_empty() || opt.contains("%(AdditionalOptions)") {
                                continue;
                            }
                            additional_options.push(opt.to_string());
                        }
                    }
                }

                let options = ProjectCompileOptionsNative {
                    include_directories: include_dirs,
                    preprocessor_definitions: preproc_defs,
                    language_standard: std,
                    additional_options,
                };

                if let Some(cond) = condition {
                    // Extract 'Debug|x64' from Condition="'$(Configuration)|$(Platform)'=='Debug|x64'"
                    if let Some(eq_pos) = cond.find("=='") {
                        let rest_eq = &cond[eq_pos + 3..];
                        if let Some(end_q) = rest_eq.find('\'') {
                            let config_key = rest_eq[..end_q].trim().to_string();
                            let mut merged = default_compile_options.clone();
                            for inc in options.include_directories {
                                if !merged.include_directories.contains(&inc) {
                                    merged.include_directories.push(inc);
                                }
                            }
                            for def in options.preprocessor_definitions {
                                if !merged.preprocessor_definitions.contains(&def) {
                                    merged.preprocessor_definitions.push(def);
                                }
                            }
                            merged.language_standard = options.language_standard;
                            merged.additional_options.extend(options.additional_options);
                            compile_options_by_config.insert(config_key, merged);
                        }
                    }
                } else {
                    default_compile_options = options;
                }
            }
        }
        id_rest = &id_rest[end_group..];
    }

    Ok(VcxProjectModelNative {
        file_path,
        name: project_name,
        guid,
        configuration_type,
        configurations,
        compile_options_by_config,
        default_compile_options,
        source_files,
        header_files,
        target_name,
        out_dir,
    })
}

#[napi]
pub fn generate_compile_commands_native(
    solution: SolutionModelNative,
    projects: Vec<VcxProjectModelNative>,
    compiler_path: String,
    compiler_type: String,
    system_includes: Vec<String>,
    active_configuration: Option<String>,
    include_headers: Option<bool>,
) -> Vec<CompileCommandEntryNative> {
    let mut entries = Vec::new();
    let mut seen_files = HashSet::new();

    let target_config = active_configuration
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| {
            solution
                .configurations
                .first()
                .map(|c| c.key.clone())
                .unwrap_or_else(|| "Debug|x64".to_string())
        });

    let norm_compiler_bin = normalize_slash(&compiler_path);
    let inc_headers = include_headers.unwrap_or(false);

    for project in &projects {
        let p_path = Path::new(&project.file_path);
        let project_dir = normalize_slash(&p_path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default());
        let project_opts = project
            .compile_options_by_config
            .get(&target_config)
            .unwrap_or(&project.default_compile_options);

        let standard = if project_opts.language_standard.is_empty() {
            "c++20"
        } else {
            &project_opts.language_standard
        };

        let mut all_includes = Vec::new();
        all_includes.push(project_dir.clone());
        for inc in &project_opts.include_directories {
            let n = normalize_slash(inc);
            if !all_includes.contains(&n) {
                all_includes.push(n);
            }
        }
        for inc in &system_includes {
            let n = normalize_slash(inc);
            if !all_includes.contains(&n) {
                all_includes.push(n);
            }
        }

        let mut file_entries: Vec<(String, bool)> = project
            .source_files
            .iter()
            .map(|f| (normalize_slash(f), false))
            .collect();
        if inc_headers {
            for h in &project.header_files {
                file_entries.push((normalize_slash(h), true));
            }
        }

        for (file, is_header) in file_entries {
            let lower = file.to_lowercase();
            if seen_files.contains(&lower) {
                continue;
            }
            seen_files.insert(lower);

            let is_c_file = file.ends_with(".c") || file.ends_with(".C");
            let mut args = Vec::new();
            let mut cmd_parts = Vec::new();

            if compiler_type == "msvc" {
                args.push(norm_compiler_bin.clone());
                args.push("--driver-mode=cl".to_string());
                cmd_parts.push(format!("\"{}\"", norm_compiler_bin));
                cmd_parts.push("--driver-mode=cl".to_string());

                if is_c_file {
                    args.push("/TC".to_string());
                    cmd_parts.push("/TC".to_string());
                    args.push("/std:c11".to_string());
                    cmd_parts.push("/std:c11".to_string());
                } else {
                    args.push(format!("/std:{}", standard));
                    args.push("/EHsc".to_string());
                    args.push("/TP".to_string());
                    cmd_parts.push(format!("/std:{}", standard));
                    cmd_parts.push("/EHsc".to_string());
                    cmd_parts.push("/TP".to_string());
                }
                args.push("/W4".to_string());
                cmd_parts.push("/W4".to_string());

                for inc in &all_includes {
                    args.push(format!("-I{}", inc));
                    cmd_parts.push(format!("-I\"{}\"", inc));
                }
                for def in &project_opts.preprocessor_definitions {
                    args.push(format!("-D{}", def));
                    cmd_parts.push(format!("-D{}", def));
                }
                for opt in &project_opts.additional_options {
                    args.push(opt.clone());
                    cmd_parts.push(opt.clone());
                }

                args.push("/c".to_string());
                args.push(file.clone());
                cmd_parts.push("/c".to_string());
                cmd_parts.push(format!("\"{}\"", file));
            } else {
                args.push(norm_compiler_bin.clone());
                cmd_parts.push(format!("\"{}\"", norm_compiler_bin));

                if is_c_file {
                    args.push("-xc".to_string());
                    args.push("-std=c11".to_string());
                    cmd_parts.push("-xc".to_string());
                    cmd_parts.push("-std=c11".to_string());
                } else {
                    let flag = if is_header { "-xc++-header" } else { "-xc++" };
                    args.push(flag.to_string());
                    args.push(format!("-std={}", standard));
                    cmd_parts.push(flag.to_string());
                    cmd_parts.push(format!("-std={}", standard));
                }
                args.push("-Wall".to_string());
                cmd_parts.push("-Wall".to_string());

                for inc in &all_includes {
                    args.push(format!("-I{}", inc));
                    cmd_parts.push(format!("-I\"{}\"", inc));
                }
                for def in &project_opts.preprocessor_definitions {
                    args.push(format!("-D{}", def));
                    cmd_parts.push(format!("-D{}", def));
                }
                for opt in &project_opts.additional_options {
                    args.push(opt.clone());
                    cmd_parts.push(opt.clone());
                }

                args.push("-c".to_string());
                args.push(file.clone());
                cmd_parts.push("-c".to_string());
                cmd_parts.push(format!("\"{}\"", file));
            }

            let command = cmd_parts.join(" ");
            entries.push(CompileCommandEntryNative {
                directory: project_dir.clone(),
                command,
                arguments: Some(args),
                file,
            });
        }
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sln_and_vcxproj() {
        let sln_text = r#"
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "GameEngine", "src\GameEngine.vcxproj", "{ABC-123}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|x64 = Debug|x64
		Release|x64 = Release|x64
	EndGlobalSection
EndGlobal
"#;
        let sln = parse_sln_content_native(sln_text.to_string(), "C:/code/MyGame.sln".to_string()).unwrap();
        assert_eq!(sln.name, "MyGame");
        assert_eq!(sln.projects.len(), 1);
        assert_eq!(sln.projects[0].name, "GameEngine");
        assert_eq!(sln.projects[0].relative_path, "src/GameEngine.vcxproj");
        assert_eq!(sln.configurations.len(), 2);

        let vcxproj_text = r#"
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Debug|x64">
      <Configuration>Debug</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <ProjectGuid>{ABC-123}</ProjectGuid>
  </PropertyGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <ClCompile>
      <LanguageStandard>stdcpp20</LanguageStandard>
      <AdditionalIncludeDirectories>include;$(SolutionDir)common;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
      <PreprocessorDefinitions>ENGINE_EXPORTS;%(PreprocessorDefinitions)</PreprocessorDefinitions>
    </ClCompile>
  </ItemDefinitionGroup>
  <ItemGroup>
    <ClCompile Include="main.cpp" />
    <ClInclude Include="engine.h" />
  </ItemGroup>
</Project>
"#;
        let proj = parse_vcxproj_content_native(
            vcxproj_text.to_string(),
            "C:/code/src/GameEngine.vcxproj".to_string(),
            Some("C:/code".to_string()),
        ).unwrap();

        assert_eq!(proj.name, "GameEngine");
        assert_eq!(proj.source_files.len(), 1);
        assert_eq!(proj.source_files[0], "C:/code/src/main.cpp");
        assert_eq!(proj.header_files.len(), 1);
        assert_eq!(proj.header_files[0], "C:/code/src/engine.h");

        let cmds = generate_compile_commands_native(
            sln,
            vec![proj],
            "C:/LLVM/bin/clang-cl.exe".to_string(),
            "msvc".to_string(),
            vec!["C:/MSVC/include".to_string()],
            Some("Debug|x64".to_string()),
            Some(false),
        );

        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].file, "C:/code/src/main.cpp");
        assert!(cmds[0].command.contains("/std:c++20"));
        assert!(cmds[0].command.contains("-DENGINE_EXPORTS"));
    }
}
