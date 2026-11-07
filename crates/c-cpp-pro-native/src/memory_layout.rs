use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RawFieldNative {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FieldLayoutNative {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub offset: u32,
    pub size: u32,
    pub alignment: u32,
    pub is_padding: bool,
    pub padding_size: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StructLayoutOptionsNative {
    pub is_packed: Option<bool>,
    pub max_pack_alignment: Option<u32>,
    pub skip_optimization: Option<bool>,
    pub data_model: Option<String>, // "LP64" | "LLP64"
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StructLayoutNative {
    pub name: String,
    pub total_size: u32,
    pub alignment: u32,
    pub padding_bytes: u32,
    pub cache_lines: u32,
    pub fields: Vec<FieldLayoutNative>,
    pub is_packed: bool,
    pub optimized_size: Option<u32>,
    pub recommendation: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TypeInfo {
    pub size: u32,
    pub alignment: u32,
}

pub fn resolve_type_info(type_str: &str, data_model: &str) -> TypeInfo {
    let trimmed = type_str.trim();

    // Pointer or reference types are always 8 bytes on 64-bit architectures
    if trimmed.ends_with('*') || trimmed.ends_with('&') {
        return TypeInfo {
            size: 8,
            alignment: 8,
        };
    }

    // Check for fixed arrays: e.g. int[10] or int[10][20]
    if let Some(bracket_pos) = trimmed.find('[') {
        if trimmed.ends_with(']') {
            let elem_type = trimmed[..bracket_pos].trim();
            let mut total_count: u32 = 1;
            let mut rest = &trimmed[bracket_pos..];

            while let Some(open) = rest.find('[') {
                if let Some(close) = rest[open..].find(']') {
                    let dim_str = &rest[open + 1..open + close];
                    if let Ok(dim) = dim_str.trim().parse::<u32>() {
                        total_count = total_count.saturating_mul(dim);
                    }
                    rest = &rest[open + close + 1..];
                } else {
                    break;
                }
            }

            let elem_info = resolve_type_info(elem_type, data_model);
            return TypeInfo {
                size: elem_info.size.saturating_mul(total_count),
                alignment: elem_info.alignment,
            };
        }
    }

    let is_llp64 = data_model.eq_ignore_ascii_case("LLP64");

    match trimmed {
        "bool" | "char" | "signed char" | "unsigned char" | "int8_t" | "uint8_t" | "BYTE" | "char8_t" => TypeInfo {
            size: 1,
            alignment: 1,
        },
        "short" | "unsigned short" | "int16_t" | "uint16_t" | "WORD" | "char16_t" | "wchar_t" => TypeInfo {
            size: 2,
            alignment: 2,
        },
        "int" | "unsigned int" | "unsigned" | "int32_t" | "uint32_t" | "float" | "DWORD" | "BOOL" | "char32_t" => TypeInfo {
            size: 4,
            alignment: 4,
        },
        "long" | "unsigned long" => {
            if is_llp64 {
                TypeInfo {
                    size: 4,
                    alignment: 4,
                }
            } else {
                TypeInfo {
                    size: 8,
                    alignment: 8,
                }
            }
        }
        "long double" => {
            if is_llp64 {
                TypeInfo {
                    size: 8,
                    alignment: 8,
                }
            } else {
                TypeInfo {
                    size: 16,
                    alignment: 16,
                }
            }
        }
        "long long" | "unsigned long long" | "int64_t" | "uint64_t" | "double" | "size_t"
        | "uintptr_t" | "intptr_t" | "ptrdiff_t" | "HANDLE" | "HWND" | "HDC" | "HINSTANCE" => TypeInfo {
            size: 8,
            alignment: 8,
        },
        other => {
            if other.starts_with("enum ")
                || other.ends_with("Type")
                || other.ends_with("Kind")
                || other.ends_with("Mode")
                || other.ends_with("State")
                || other.ends_with("Status")
                || other.ends_with("Action")
                || other.ends_with("Op")
                || other.ends_with("Code")
                || other.ends_with("Flag")
                || other.ends_with("Flags")
                || other.ends_with("Enum")
            {
                TypeInfo {
                    size: 4,
                    alignment: 4,
                }
            } else {
                TypeInfo {
                    size: 8,
                    alignment: 8,
                }
            }
        }
    }
}

#[napi]
pub fn calculate_struct_layout_native(
    struct_name: String,
    raw_fields: Vec<RawFieldNative>,
    options: Option<StructLayoutOptionsNative>,
) -> StructLayoutNative {
    let opts = options.unwrap_or_default();
    let is_packed = opts.is_packed.unwrap_or(false);
    let pack_max = opts
        .max_pack_alignment
        .unwrap_or(if is_packed { 1 } else { 8 });
    let data_model = opts
        .data_model
        .as_deref()
        .unwrap_or("LP64");

    let mut fields: Vec<FieldLayoutNative> = Vec::new();
    let mut current_offset: u32 = 0;
    let mut max_struct_alignment: u32 = 1;
    let mut total_padding_bytes: u32 = 0;

    for field in &raw_fields {
        let type_info = resolve_type_info(&field.r#type, data_model);
        let field_alignment = if is_packed {
            1
        } else {
            type_info.alignment.min(pack_max)
        };
        max_struct_alignment = max_struct_alignment.max(field_alignment);

        // Required padding before field
        let remainder = current_offset % field_alignment;
        if remainder != 0 {
            let pad_size = field_alignment - remainder;
            fields.push(FieldLayoutNative {
                name: format!("[padding_{}B]", pad_size),
                r#type: "padding".to_string(),
                offset: current_offset,
                size: pad_size,
                alignment: 1,
                is_padding: true,
                padding_size: Some(pad_size),
            });
            current_offset += pad_size;
            total_padding_bytes += pad_size;
        }

        fields.push(FieldLayoutNative {
            name: field.name.clone(),
            r#type: field.r#type.clone(),
            offset: current_offset,
            size: type_info.size,
            alignment: field_alignment,
            is_padding: false,
            padding_size: None,
        });

        current_offset += type_info.size;
    }

    // Trailing padding to align entire struct
    let tail_remainder = current_offset % max_struct_alignment;
    if tail_remainder != 0 && !is_packed {
        let tail_pad = max_struct_alignment - tail_remainder;
        fields.push(FieldLayoutNative {
            name: format!("[tail_padding_{}B]", tail_pad),
            r#type: "padding".to_string(),
            offset: current_offset,
            size: tail_pad,
            alignment: 1,
            is_padding: true,
            padding_size: Some(tail_pad),
        });
        current_offset += tail_pad;
        total_padding_bytes += tail_pad;
    }

    let total_size = current_offset;
    let cache_lines = ((total_size as f64) / 64.0).ceil().max(1.0) as u32;

    // Field reordering optimization
    let mut optimized_size = None;
    let mut recommendation = None;

    if total_padding_bytes > 0 && !is_packed && !opts.skip_optimization.unwrap_or(false) {
        let mut sorted_fields = raw_fields.clone();
        sorted_fields.sort_by(|a, b| {
            let a_info = resolve_type_info(&a.r#type, data_model);
            let b_info = resolve_type_info(&b.r#type, data_model);
            b_info
                .alignment
                .cmp(&a_info.alignment)
                .then_with(|| b_info.size.cmp(&a_info.size))
        });

        let opt_opts = StructLayoutOptionsNative {
            is_packed: Some(false),
            max_pack_alignment: Some(pack_max),
            skip_optimization: Some(true),
            data_model: Some(data_model.to_string()),
        };
        let opt_layout = calculate_struct_layout_native(struct_name.clone(), sorted_fields.clone(), Some(opt_opts));
        let opt_size = opt_layout.total_size;
        optimized_size = Some(opt_size);

        if opt_size < total_size {
            let saved = total_size - opt_size;
            let names: Vec<String> = sorted_fields.iter().map(|f| f.name.clone()).collect();
            let reorder_list = names.join(", ");
            let pct = (((saved as f64) / (total_size as f64)) * 100.0).round() as u32;
            recommendation = Some(format!(
                "Reorder fields to [{}] to save {} byte{} ({}% reduction).",
                reorder_list,
                saved,
                if saved > 1 { "s" } else { "" },
                pct
            ));
        }
    }

    StructLayoutNative {
        name: struct_name,
        total_size,
        alignment: max_struct_alignment,
        padding_bytes: total_padding_bytes,
        cache_lines,
        fields,
        is_packed,
        optimized_size,
        recommendation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_struct_layout_with_padding() {
        let fields = vec![
            RawFieldNative {
                name: "flag".to_string(),
                r#type: "bool".to_string(),
            },
            RawFieldNative {
                name: "id".to_string(),
                r#type: "int64_t".to_string(),
            },
            RawFieldNative {
                name: "count".to_string(),
                r#type: "int".to_string(),
            },
        ];

        let layout = calculate_struct_layout_native("MyStruct".to_string(), fields, None);

        // bool (1B) + 7B pad + int64_t (8B) + int (4B) + 4B tail pad = 24B
        assert_eq!(layout.total_size, 24);
        assert_eq!(layout.alignment, 8);
        assert_eq!(layout.padding_bytes, 11);
        assert!(layout.optimized_size.unwrap() < 24);
        assert!(layout.recommendation.is_some());
    }

    #[test]
    fn test_packed_struct() {
        let fields = vec![
            RawFieldNative {
                name: "a".to_string(),
                r#type: "char".to_string(),
            },
            RawFieldNative {
                name: "b".to_string(),
                r#type: "int".to_string(),
            },
        ];

        let opts = StructLayoutOptionsNative {
            is_packed: Some(true),
            ..Default::default()
        };
        let layout = calculate_struct_layout_native("PackedStruct".to_string(), fields, Some(opts));

        assert_eq!(layout.total_size, 5);
        assert_eq!(layout.alignment, 1);
        assert_eq!(layout.padding_bytes, 0);
    }

    #[test]
    fn test_llp64_data_model() {
        let fields = vec![RawFieldNative {
            name: "val".to_string(),
            r#type: "long".to_string(),
        }];

        let opts_lp64 = StructLayoutOptionsNative {
            data_model: Some("LP64".to_string()),
            ..Default::default()
        };
        let layout_lp = calculate_struct_layout_native("S".to_string(), fields.clone(), Some(opts_lp64));
        assert_eq!(layout_lp.total_size, 8);

        let opts_llp64 = StructLayoutOptionsNative {
            data_model: Some("LLP64".to_string()),
            ..Default::default()
        };
        let layout_llp = calculate_struct_layout_native("S".to_string(), fields, Some(opts_llp64));
        assert_eq!(layout_llp.total_size, 4);
    }
}
