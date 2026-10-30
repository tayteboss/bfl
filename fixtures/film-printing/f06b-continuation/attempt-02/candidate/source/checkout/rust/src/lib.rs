//! Offline candidate for the four F06A targets. Uses Shopify's supported lazy
//! Wasm input API: ordinary carts never deserialize the authority or claims.
//! The bounded authority JSON is the only data parsed with serde_json.
use serde_json::{json, Value as Json};
use shopify_function::wasm_api::{self, Context, Value};

const STORE: &str = "bellows-film-printing-staging.myshopify.com";
const PRODUCT: &str = "gid://shopify/Product/15620086005871";
const VARIANT: &str = "gid://shopify/ProductVariant/67852705202287";
const CLAIMS: [&str; 13] = [
    "flow",
    "job",
    "revision",
    "config",
    "signature",
    "service",
    "size",
    "paper",
    "lab",
    "message",
    "borders",
    "turnaround",
    "files",
];
const MAX_BYTES: usize = 6000;
const MAX_LINES: usize = 8;
const MAX_CART_LINES: usize = 20;

fn at(mut v: Value, path: &[&'static str]) -> Value {
    for key in path {
        v = v.get_interned_obj_prop(wasm_api::CachedInternedStringId::new(key).load());
    }
    v
}
fn string(v: Value) -> String {
    v.as_string().unwrap_or_default()
}
fn attr(v: Value, key: &'static str) -> String {
    string(at(v, &[key, "value"]))
}
fn array(v: Value) -> impl Iterator<Item = Value> {
    (0..v.array_len().unwrap_or(0)).map(move |i| v.get_at_index(i))
}
fn product(v: Value) -> bool {
    string(at(v, &["merchandise", "id"])) == VARIANT
        || string(at(v, &["merchandise", "product", "id"])) == PRODUCT
}
fn targeted(v: Value) -> bool {
    product(v) || !attr(v, "flow").is_empty()
}
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}
fn text(v: &Json) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && js_len(s) <= 200)
}
fn hex(v: &Json) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn gid(v: &Json, kind: &str) -> bool {
    v.as_str()
        .is_some_and(|s| s.starts_with(&format!("gid://shopify/{kind}/")) && js_len(s) <= 200)
}
fn keys(v: &Json, names: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == names.len() && names.iter().all(|k| o.contains_key(*k)))
}
fn integer(v: &Json, max: f64) -> Option<u64> {
    v.as_f64()
        .filter(|n| *n > 0.0 && *n <= max && n.fract() == 0.0)
        .map(|n| n as u64)
}
fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}
fn decimal(s: &str) -> bool {
    match s.split_once('.') {
        Some((a, b)) => digits(a) && digits(b),
        None => digits(s),
    }
}
fn day(s: &str) -> bool {
    s.len() == 10
        && s.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

fn decode(raw: &str) -> Option<Json> {
    if raw.len() > MAX_BYTES || !raw.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return None;
    }
    let a: Json = serde_json::from_str(raw).ok()?;
    let sha = a["config_sha256"].as_str()?;
    let config = a["config_version"].as_str()?;
    if !keys(
        &a,
        &[
            "schema",
            "store",
            "config_version",
            "config_sha256",
            "price_version",
            "valid_on",
            "grants",
        ],
    ) || a["schema"].as_f64() != Some(1.0)
        || a["store"] != STORE
        || !hex(&a["config_sha256"])
        || config != format!("f03-{}", &sha[..24])
        || !text(&a["price_version"])
        || !day(a["valid_on"].as_str()?)
    {
        return None;
    }
    let grants = a["grants"].as_array()?;
    if grants.len() > 8 {
        return None;
    }
    let mut carts = Vec::new();
    let mut ids = Vec::new();
    let mut jobs = Vec::new();
    for g in grants {
        if !keys(g, &["cart", "owner", "customer_id", "lines"])
            || !hex(&g["cart"])
            || !hex(&g["owner"])
            || (!g["customer_id"].is_null() && !gid(&g["customer_id"], "Customer"))
            || carts.contains(&&g["cart"])
        {
            return None;
        }
        carts.push(&g["cart"]);
        let lines = g["lines"].as_array()?;
        if lines.is_empty() || lines.len() > MAX_LINES {
            return None;
        }
        let mut total = 0;
        for l in lines {
            let q = integer(&l["quantity"], 10000.0)?;
            let files = integer(&l["file_count"], 10000.0)?;
            // All accepted values fit this bound, avoiding overflow before multiplication.
            let price = integer(&l["unit_cents"], 200000.0)?;
            let c = &l["claims"];
            if !keys(
                l,
                &[
                    "id",
                    "quantity",
                    "unit_cents",
                    "file_count",
                    "location_id",
                    "claims",
                ],
            ) || !gid(&l["id"], "CartLine")
                || ids.contains(&&l["id"])
                || price * q > 200000
                || !gid(&l["location_id"], "Location")
                || !keys(c, &CLAIMS)
                || c.as_object()?
                    .values()
                    .any(|v| v.as_str().is_none_or(|s| js_len(s) > 2000))
                || c["flow"] != "f05"
                || !text(&c["job"])
                || jobs.contains(&&c["job"])
                || !hex(&c["revision"])
                || !hex(&c["signature"])
                || c["config"] != config
                || c["files"] != files.to_string()
                || !text(&c["lab"])
                || !text(&c["paper"])
                || (c["service"] != "photo" && c["service"] != "fine_art")
            {
                return None;
            }
            let (w, h) = c["size"].as_str()?.split_once('x')?;
            if !decimal(w) || !decimal(h) {
                return None;
            }
            ids.push(&l["id"]);
            jobs.push(&c["job"]);
            if ids.len() > MAX_LINES {
                return None;
            }
            total += price * q;
        }
        if total > 200000 {
            return None;
        }
    }
    Some(a)
}

struct Checked {
    selected: Vec<(usize, Value)>,
    approved: Vec<(Value, Json)>,
    valid: bool,
}
fn inspect(input: Value) -> Checked {
    let lines = at(input, &["cart", "lines"]);
    // Preserve the existing staging envelope. This branch now reads only product
    // identities lazily; it does not eagerly allocate every queried property.
    if lines.array_len().unwrap_or(0) > MAX_CART_LINES {
        let selected: Vec<_> = array(lines)
            .enumerate()
            .find(|(_, v)| product(*v))
            .into_iter()
            .collect();
        return Checked {
            valid: selected.is_empty(),
            selected,
            approved: vec![],
        };
    }
    let mut result = Checked {
        selected: array(lines)
            .enumerate()
            .filter(|(_, v)| targeted(*v))
            .collect(),
        approved: vec![],
        valid: false,
    };
    if result.selected.is_empty() {
        result.valid = true;
        return result;
    }
    let Some(a) = decode(&string(at(input, &["shop", "authority", "value"]))) else {
        return result;
    };
    if a["valid_on"] != string(at(input, &["shop", "localTime", "date"])) {
        return result;
    }
    let matches: Vec<_> = a["grants"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|g| {
            let ls = g["lines"].as_array().unwrap();
            ls.len() == result.selected.len()
                && ls.iter().all(|l| {
                    result
                        .selected
                        .iter()
                        .any(|(_, s)| l["id"] == string(at(*s, &["id"])))
                })
        })
        .collect();
    if matches.len() != 1 {
        return result;
    }
    let mut ids = Vec::new();
    for (_, s) in &result.selected {
        let id = string(at(*s, &["id"]));
        if ids.contains(&id) {
            return result;
        }
        ids.push(id);
    }
    let g = matches[0];
    let buyer = at(input, &["cart", "buyerIdentity"]);
    let authenticated = at(buyer, &["isAuthenticated"]).as_bool() == Some(true);
    let customer = at(buyer, &["customer"]);
    if if g["customer_id"].is_null() {
        authenticated || customer.is_obj()
    } else {
        !authenticated || g["customer_id"] != string(at(customer, &["id"]))
    } {
        return result;
    }
    let mut approved = Vec::new();
    for (_, s) in &result.selected {
        let id = string(at(*s, &["id"]));
        let l = g["lines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["id"] == id)
            .unwrap();
        if string(at(*s, &["merchandise", "id"])) != VARIANT
            || string(at(*s, &["merchandise", "product", "id"])) != PRODUCT
            || at(*s, &["quantity"]).as_number() != l["quantity"].as_f64()
            || at(*s, &["sellingPlanAllocation"]).is_obj()
            || string(at(*s, &["cost", "amountPerQuantity", "currencyCode"])) != "USD"
            || CLAIMS.iter().any(|key| l["claims"][key] != attr(*s, key))
        {
            return result;
        }
        approved.push((*s, l.clone()));
    }
    result.approved = approved;
    result.valid = true;
    result
}

fn cents(s: &str) -> Option<u64> {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if !digits(whole) || (s.contains('.') && (!digits(frac) || frac.len() > 2)) {
        return None;
    }
    let whole: u64 = whole.parse().ok()?;
    whole.checked_mul(100)?.checked_add(match frac.len() {
        0 => 0,
        1 => frac.parse::<u64>().ok()? * 10,
        _ => frac.parse().ok()?,
    })
}
fn run(input: Value, target: u8) -> Json {
    if target == 1 && string(at(input, &["buyerJourney", "step"])) == "CART_INTERACTION" {
        return json!({"operations":[]});
    }
    let checked = inspect(input);
    let mut operations = Vec::new();
    match target {
        0 => {
            if checked.valid {
                for (_, l) in &checked.approved {
                    let price = integer(&l["unit_cents"], 200000.0).unwrap();
                    operations.push(json!({"lineUpdate":{"cartLineId":l["id"],"price":{"adjustment":{"fixedPricePerUnit":{"amount":format!("{}.{:02}",price/100,price%100)}}}}}));
                }
            }
        }
        1 => {
            let correct = checked.valid
                && checked.approved.iter().all(|(s, l)| {
                    cents(&string(at(*s, &["cost", "subtotalAmount", "amount"])))
                        == Some(
                            integer(&l["unit_cents"], 200000.0).unwrap()
                                * integer(&l["quantity"], 10000.0).unwrap(),
                        )
                        && array(at(input, &["cart", "deliverableLines"]))
                            .filter(|d| l["claims"]["job"] == attr(*d, "job"))
                            .count()
                            == 1
                });
            if !correct && !checked.selected.is_empty() {
                let errors: Vec<_>=checked.selected.iter().map(|(i,_)| json!({"message":"This staging print job is unavailable or has changed. Return to the print form.","target":format!("$.cart.lines[{i}]")})).collect();
                operations.push(json!({"validationAdd":{"errors":errors}}));
            }
        }
        2 => {
            if checked.valid {
                for (_, l) in &checked.approved {
                    let matches: Vec<_> = array(at(input, &["cart", "deliverableLines"]))
                        .filter(|d| l["claims"]["job"] == attr(*d, "job"))
                        .collect();
                    if matches.len() == 1 {
                        operations.push(json!({"deliverableLinesMustFulfillFromAdd":{"deliverableLineIds":[string(at(matches[0],&["id"]))],"locationIds":[l["location_id"]]}}));
                    }
                }
            }
        }
        3 => {
            let ids: Vec<_> = checked
                .selected
                .iter()
                .map(|(_, l)| string(at(*l, &["id"])))
                .collect();
            for group in array(at(input, &["cart", "deliveryGroups"])) {
                if !array(at(group, &["cartLines"]))
                    .any(|l| ids.contains(&string(at(l, &["id"]))) || targeted(l))
                {
                    continue;
                }
                for option in array(at(group, &["deliveryOptions"])) {
                    if checked.valid && string(at(option, &["deliveryMethodType"])) == "PICK_UP" {
                        continue;
                    }
                    operations.push(json!({"deliveryOptionHide":{"deliveryOptionHandle":string(at(option,&["handle"]))}}));
                }
            }
        }
        _ => unreachable!(),
    }
    json!({"operations":operations})
}

// Serialize the small result directly through Shopify's output API, without a
// stdout JSON adapter. Schema validation in the harness covers all four outputs.
fn write(ctx: &mut Context, value: &Json) -> Result<(), wasm_api::write::Error> {
    match value {
        Json::Null => ctx.write_null(),
        Json::Bool(b) => ctx.write_bool(*b),
        Json::Number(n) => ctx.write_f64(n.as_f64().unwrap()),
        Json::String(s) => ctx.write_utf8_str(s),
        Json::Array(a) => ctx.write_array(
            |ctx| {
                for v in a {
                    write(ctx, v)?;
                }
                Ok(())
            },
            a.len(),
        ),
        Json::Object(o) => ctx.write_object(
            |ctx| {
                for (k, v) in o {
                    ctx.write_utf8_str(k)?;
                    write(ctx, v)?;
                }
                Ok(())
            },
            o.len(),
        ),
    }
}
fn execute(target: u8) {
    wasm_api::init_panic_handler();
    let mut ctx = Context::new();
    let input = ctx.input_get().expect("Function input unavailable");
    write(&mut ctx, &run(input, target)).expect("Function output failed");
}
#[no_mangle]
pub extern "C" fn cart_transform_run() {
    execute(0);
}
#[no_mangle]
pub extern "C" fn cart_validations_generate_run() {
    execute(1);
}
#[no_mangle]
pub extern "C" fn cart_fulfillment_constraints_generate_run() {
    execute(2);
}
#[no_mangle]
pub extern "C" fn cart_delivery_options_transform_run() {
    execute(3);
}
