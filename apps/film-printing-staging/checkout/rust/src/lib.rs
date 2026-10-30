//! Offline candidate for the four F06A targets. Uses Shopify's supported lazy
//! Wasm input API: ordinary carts never deserialize the authority or claims.
//! The bounded authority JSON is the only data parsed with serde_json.
use serde_json::{json, Value as Json};
use shopify_function::wasm_api::{self, Context, Value};

const STORE: &str = "bellows-film-printing-staging.myshopify.com";
const PRODUCT: &str = "gid://shopify/Product/15620086005871";
const VARIANT: &str = "gid://shopify/ProductVariant/67852705202287";
const VARIANTS_BY_LAB: [(&str, &str); 4] = [
    ("miami", "gid://shopify/ProductVariant/68068335714415"),
    ("chicago", "gid://shopify/ProductVariant/68068358848623"),
    ("orlando", "gid://shopify/ProductVariant/68068358881391"),
    ("atlanta", "gid://shopify/ProductVariant/68068358914159"),
];
fn variant_for_lab(lab: &str) -> Option<&'static str> {
    VARIANTS_BY_LAB.iter().find_map(|(name,id)| (*name == lab).then_some(*id))
}
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
const EXTRA_CLAIMS: [&str; 6] = ["size_mode", "width", "height", "process", "scanning", "negatives"];
// Exact display projection; canonical authority claims never change.
fn display_claims(c: &Json) -> Option<Json> {
    let service = match c["service"].as_str()? { "photo"=>"Photo Prints", "fine_art"=>"Fine Arts", "darkroom"=>"Darkroom Prints", _=>return None };
    let paper = match c["paper"].as_str()? { "matte"=>"Matte", "luster"=>"Luster", "glossy"=>"Glossy", "fibre-paper"=>"Fibre Paper", "rc-matte"=>"RC Matte", "rc-luster"=>"RC Luster", "photo-premium-luster"=>"premium luster paper", _=>return None };
    let lab = match c["lab"].as_str()? { "miami"=>"Miami", "chicago"=>"Chicago", "orlando"=>"Orlando", "atlanta"=>"Atlanta", _=>return None };
    let size = if c["size_mode"]=="custom" { format!("{}\" × {}\" (Custom)",c["width"].as_str()?,c["height"].as_str()?) }
        else { c["size"].as_str()?.split('x').map(|side| format!("{}”",side)).collect::<Vec<_>>().join(" × ") };
    let mut result=c.clone();result["service"]=json!(service);result["paper"]=json!(paper);result["lab"]=json!(lab);result["size"]=json!(size);Some(result)
}
fn claims_match(s: Value, claims: &Json, specification: bool, full: bool, v3: bool, quantity: u64) -> bool {
    (if specification { &CLAIMS[..5] } else { &CLAIMS[..] }).iter().chain(if specification && full { &EXTRA_CLAIMS[..] } else { &[] }).all(|key| if v3 && *key=="signature" {
        attr(s,key)==format!("v3:{}:{}",claims["signature"].as_str().unwrap(),quantity)
    } else { claims[key]==attr(s,key) })
}

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
    let variant = string(at(v, &["merchandise", "id"]));
    variant == VARIANT || VARIANTS_BY_LAB.iter().any(|(_,id)| variant == *id)
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

fn eligibility(a: &Json) -> bool {
    matches!(a["schema"].as_f64(), Some(3.0) | Some(4.0) | Some(5.0))
}
fn full_product(a: &Json) -> bool { matches!(a["schema"].as_f64(), Some(4.0) | Some(5.0)) }
fn lab_variants(a: &Json) -> bool { a["schema"].as_f64() == Some(5.0) }
fn valid_selection(c: &Json, files: u64, full: bool) -> bool {
    let Some(size) = c["size"].as_str() else { return false; };
    let Some((w,h)) = size.split_once('x') else { return false; };
    if !decimal(w) || !decimal(h) { return false; }
    if !full { return files > 0 && (c["service"] == "photo" || c["service"] == "fine_art"); }
    if c["size_mode"] == "custom" {
        let Some(width) = c["width"].as_str() else { return false; };
        let Some(height) = c["height"].as_str() else { return false; };
        if c["service"] != "fine_art" || !digits(width) || !digits(height) || width.starts_with('0') || height.starts_with('0') { return false; }
        let (Ok(width), Ok(height)) = (width.parse::<u64>(), height.parse::<u64>()) else { return false; };
        if width > 44 || height > 9007199254740991 || size != format!("{}x{}", width.min(height), width.max(height)) { return false; }
    } else if c["size_mode"] != "fixed" || c["width"] != "" || c["height"] != "" { return false; }
    if c["service"] == "darkroom" {
        files == 0 && c["size_mode"] == "fixed" && ["8x10","11x14","12x16","16x20"].contains(&size)
            && ["Color","Black and White"].iter().any(|v| c["process"] == *v)
            && ["Already at Bellows","Drop Off","Mail In"].iter().any(|v| c["negatives"] == *v)
            && if ["8x10","11x14"].contains(&size) { c["scanning"] == "Yes" || c["scanning"] == "No" } else { c["scanning"] == "" }
    } else {
        files > 0 && (c["service"] == "photo" || c["service"] == "fine_art")
            && c["process"] == "" && c["scanning"] == "" && c["negatives"] == ""
    }
}
// JSON storage can unescape Unicode. Count the same ASCII-escaped UTF-16
// units as the publisher without changing any protected string value.
fn bounded_json(raw: &str, max: usize) -> bool {
    raw.len() <= max && raw.encode_utf16().try_fold(0usize, |bytes,c| {
        let next = bytes + if c >= 0x7f {6} else {1};
        if c < 0x20 || next > max {None} else {Some(next)}
    }).is_some()
}
fn decode(raw: &str) -> Option<Json> {
    if !bounded_json(raw, MAX_BYTES) {
        return None;
    }
    decode_value(serde_json::from_str(raw).ok()?)
}
fn lease(v: &Json) -> bool {
    keys(v, &["token", "deadline", "expires_at"])
        && hex(&v["token"])
        && integer(&v["expires_at"], 9007199254740991.0).is_some()
        && v["deadline"].as_str().is_some_and(|s| s.len() == 19 && s.bytes().enumerate().all(|(i,b)| match i {4|7=>b==b'-',10=>b==b'T',13|16=>b==b':',_=>b.is_ascii_digit()}))
}
fn decode_envelope(raw: &str) -> Option<Json> {
    if !bounded_json(raw, MAX_BYTES + 128) { return None; }
    let e: Json = serde_json::from_str(raw).ok()?;
    if !keys(&e, &["deadline", "authority"]) { return None; }
    let a = e["authority"].clone();
    let canonical = serde_json::to_string(&a).ok()?;
    let bytes: usize = canonical.encode_utf16().map(|c| if c >= 0x7f {6} else {1}).sum();
    if bytes > MAX_BYTES { return None; }
    let a = decode_value(a)?;
    if !eligibility(&a) || e["deadline"] != a["lease"]["deadline"] { return None; }
    Some(a)
}
fn decode_value(a: Json) -> Option<Json> {
    let v3 = eligibility(&a);
    let full = full_product(&a);
    let sha = a["config_sha256"].as_str()?;
    let config = a["config_version"].as_str()?;
    if !keys(
        &a,
        if v3 { &["schema","store","config_version","config_sha256","price_version","valid_on","grants","lease"] } else { &[
            "schema",
            "store",
            "config_version",
            "config_sha256",
            "price_version",
            "valid_on",
            "grants",
        ] },
    ) || (!v3 && a["schema"].as_f64() != Some(2.0))
        || (v3 && !lease(&a["lease"]))
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
    let mut bindings = Vec::new();
    let mut jobs = Vec::new();
    for g in grants {
        if !keys(g, &["cart", "owner", "customer_id", "lines", "binding", "generation", "epoch"])
            || !hex(&g["cart"])
            || !hex(&g["owner"])
            || !hex(&g["binding"]) || bindings.contains(&&g["binding"])
            || integer(&g["generation"], 9007199254740991.0).is_none()
            || g["epoch"].as_f64().is_none_or(|n| n < 0.0 || n > 9007199254740991.0 || n.fract() != 0.0)
            || (!g["customer_id"].is_null() && !gid(&g["customer_id"], "Customer"))
            || carts.contains(&&g["cart"])
        {
            return None;
        }
        carts.push(&g["cart"]);
        bindings.push(&g["binding"]);
        let lines = g["lines"].as_array()?;
        if lines.is_empty() || lines.len() > MAX_LINES {
            return None;
        }
        let mut total = 0;
        for l in lines {
            let q = if v3 { 1 } else { integer(&l["quantity"], 10000.0)? };
            let files = if full && l["claims"]["service"] == "darkroom" && l["file_count"].as_f64() == Some(0.0) { 0 }
                else { integer(&l["file_count"], 10000.0)? };
            // All accepted values fit this bound, avoiding overflow before multiplication.
            let price = integer(&l["unit_cents"], 200000.0)?;
            let c = &l["claims"];
            if !keys(
                l,
                if lab_variants(&a) { &["unit_cents","file_count","location_id","shipping_eligible","variant_id","claims"] } else if full { &["unit_cents","file_count","location_id","shipping_eligible","claims"] } else if v3 { &["unit_cents","file_count","location_id","claims"] } else { &[
                    "quantity",
                    "unit_cents",
                    "file_count",
                    "location_id",
                    "claims",
                ] },
            ) || price * q > 200000
                || (full && !l["shipping_eligible"].is_boolean())
                || (lab_variants(&a) && (l["variant_id"].as_str().is_none() || l["variant_id"].as_str() != variant_for_lab(c["lab"].as_str()?)))
                || !gid(&l["location_id"], "Location")
                || !keys(c, &CLAIMS.iter().copied().chain(if full { &EXTRA_CLAIMS[..] } else { &[] }.iter().copied()).collect::<Vec<_>>())
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
                || !valid_selection(c, files, full)
            {
                return None;
            }
            jobs.push(&c["job"]);
            if jobs.len() > MAX_LINES {
                return None;
            }
            total += price * q;
        }
        if !v3 && total > 200000 {
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
fn inspect(input: Value, specification: bool) -> Checked {
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
    let from_owner = at(input, &["leaseOwner"]).is_obj();
    let authority = if from_owner { decode_envelope(&string(at(input, &["leaseOwner", "lease", "value"]))) }
        else { decode(&string(at(input, &["shop", "authority", "value"]))) };
    let Some(a) = authority else {
        return result;
    };
    let v3 = eligibility(&a);
    let full = full_product(&a);
    if if from_owner { !v3 || at(input, &["shop", "localTime", "beforeDeadline"]).as_bool() != Some(true) }
        else { v3 || a["valid_on"] != string(at(input, &["shop", "localTime", "date"])) } {
        return result;
    }
    let matches: Vec<_> = a["grants"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|g| {
            let ls = g["lines"].as_array().unwrap();
            g["binding"] == string(at(input, &["cart", "binding", "value"]))
                && (if v3 { result.selected.iter().all(|(_,s)| ls.iter().any(|l| l["claims"]["job"] == attr(*s,"job"))) }
                else { ls.len() == result.selected.len() && ls.iter().all(|l| {
                    result
                        .selected
                        .iter()
                        .any(|(_, s)| l["claims"]["job"] == attr(*s, "job"))
                }) })
        })
        .collect();
    if matches.len() != 1 {
        return result;
    }
    let mut ids = Vec::new();
    let mut jobs = Vec::new();
    for (_, s) in &result.selected {
        let id = string(at(*s, &["id"]));
        if !gid(&json!(id), "CartLine") || ids.contains(&id) || jobs.contains(&attr(*s, "job")) {
            return result;
        }
        ids.push(id);
        jobs.push(attr(*s, "job"));
    }
    let g = matches[0];
    let buyer = at(input, &["cart", "buyerIdentity"]);
    let authenticated = at(buyer, &["isAuthenticated"]).as_bool() == Some(true);
    let customer = at(buyer, &["customer"]);
    // A guest email can resolve a customer without authenticating the account.
    // A nullable buyer is also anonymous. Lazy property reads turn missing keys
    // into null, so require the queried parent key before accepting that case.
    let cart = at(input, &["cart"]);
    let anonymous = if buyer.is_null() {
        (0..cart.obj_len().unwrap_or(0)).any(|i| cart.get_obj_key_at_index(i).as_deref() == Some("buyerIdentity"))
    } else { buyer.is_obj() && at(buyer, &["isAuthenticated"]).as_bool() == Some(false) };
    if if g["customer_id"].is_null() {
        !anonymous
    } else {
        !authenticated || g["customer_id"] != string(at(customer, &["id"]))
    } {
        return result;
    }
    let mut approved = Vec::new();
    let mut total = 0;
    for (_, s) in &result.selected {
        let job = attr(*s, "job");
        let l = g["lines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["claims"]["job"] == job)
            .unwrap();
        let Some(q) = at(*s, &["quantity"]).as_number().filter(|q| *q >= 1.0 && *q <= 10000.0 && q.fract() == 0.0) else { return result; };
        let quantity = q as u64;
        let amount = integer(&l["unit_cents"], 200000.0).unwrap() * quantity;
        if string(at(*s, &["merchandise", "id"])) != (if lab_variants(&a) { l["variant_id"].as_str().unwrap() } else { VARIANT })
            || string(at(*s, &["merchandise", "product", "id"])) != PRODUCT
            || (!v3 && Some(q) != l["quantity"].as_f64())
            || amount > 200000
            || at(*s, &["sellingPlanAllocation"]).is_obj()
            || string(at(*s, &["cost", "amountPerQuantity", "currencyCode"])) != "USD"
            || (!full && specification && EXTRA_CLAIMS.iter().any(|key| !attr(*s,key).is_empty()))
            || !(claims_match(*s,&l["claims"],specification,full,v3,quantity) || lab_variants(&a) && display_claims(&l["claims"]).is_some_and(|display| claims_match(*s,&display,specification,full,v3,quantity)))
        {
            return result;
        }
        total += amount;
        if v3 && total > 200000 { return result; }
        let mut approved_line = l.clone();
        approved_line["quantity"] = json!(quantity);
        approved.push((*s, approved_line));
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
    if (target == 1 || target == 4) && string(at(input, &["buyerJourney", "step"])) == "CART_INTERACTION" {
        return json!({"operations":[]});
    }
    let checked = inspect(input, target == 4);
    let mut operations = Vec::new();
    match target {
        0 => {
            if checked.valid {
                for (line, l) in &checked.approved {
                    let price = integer(&l["unit_cents"], 200000.0).unwrap();
                    operations.push(json!({"lineUpdate":{"cartLineId":string(at(*line, &["id"])),"price":{"adjustment":{"fixedPricePerUnit":{"amount":format!("{}.{:02}",price/100,price%100)}}}}}));
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
            let ids: Vec<_> = array(at(input, &["cart", "lines"]))
                .filter(|l| targeted(*l))
                .map(|l| string(at(l, &["id"])))
                .collect();
            for group in array(at(input, &["cart", "deliveryGroups"])) {
                if !array(at(group, &["cartLines"]))
                    .any(|l| ids.contains(&string(at(l, &["id"]))))
                {
                    continue;
                }
                let shipping_eligible = array(at(group, &["cartLines"])).filter(|line| ids.contains(&string(at(*line, &["id"])))).all(|line|
                    checked.approved.iter().any(|(actual, approved)| string(at(*actual, &["id"])) == string(at(line, &["id"])) && approved.get("shipping_eligible").is_none_or(|value| value.as_bool() == Some(true))));
                for option in array(at(group, &["deliveryOptions"])) {
                    if checked.valid && (string(at(option, &["deliveryMethodType"])) == "PICK_UP" || (string(at(option, &["deliveryMethodType"])) == "SHIPPING" && shipping_eligible && string(at(option, &["code"])) == "BFL_SHIPPO_c355361391ae286b9b8d2d4bf6057208a9161b0a5865ac1956d083a9eb46a9c4")) {
                        continue;
                    }
                    operations.push(json!({"deliveryOptionHide":{"deliveryOptionHandle":string(at(option,&["handle"]))}}));
                }
            }
        }
        4 => {
            let choosing = string(at(input, &["buyerJourney", "step"])) == "CHECKOUT_INTERACTION";
            let pickup_valid = checked.approved.iter().filter(|(_,line)| line["shipping_eligible"] == false).all(|(line,_)| {
                let id = string(at(*line, &["id"]));
                let groups: Vec<_> = array(at(input, &["cart", "deliveryGroups"])).filter(|group|
                    array(at(*group, &["cartLines"])).any(|item| string(at(item, &["id"])) == id)).collect();
                if groups.is_empty() { return choosing; }
                if groups.len() != 1 || array(at(groups[0], &["cartLines"])).filter(|item| string(at(*item, &["id"])) == id).count() != 1 { return false; }
                let option = at(groups[0], &["selectedDeliveryOption"]);
                if option.is_null() { choosing } else { string(at(option, &["deliveryMethodType"])) == "PICK_UP" }
            });
            if (!checked.valid || !pickup_valid) && !checked.selected.is_empty() {
                let message = if checked.valid && !pickup_valid { "This print selection is available for pickup only. Choose pickup to continue." } else { "This staging print specification has changed. Return to the print form." };
                let errors: Vec<_> = checked.selected.iter().map(|(i,_)| json!({"message":message,"target":format!("$.cart.lines[{i}]")})).collect();
                operations.push(json!({"validationAdd":{"errors":errors}}));
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

#[no_mangle]
pub extern "C" fn cart_specification_validations_generate_run() {
    execute(4);
}
