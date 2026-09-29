//! Analyse JSON stricte des documents signés (PROTO-011), alignée sur
//! `packages/contracts/src/strict-json.ts` : clés dupliquées, nombres hors
//! ±(2^53−1), substituts Unicode isolés et profondeur > 64 sont refusés.

use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

/// Nombre maximal de conteneurs imbriqués.
pub const MAX_JSON_DEPTH: usize = 64;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrictJsonError(pub String);

impl fmt::Display for StrictJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StrictJsonError {}

pub fn parse_strict_json(text: &str) -> Result<Value, StrictJsonError> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = StrictSeed { depth: 0 }
        .deserialize(&mut deserializer)
        .map_err(|error| StrictJsonError(error.to_string()))?;
    deserializer
        .end()
        .map_err(|error| StrictJsonError(error.to_string()))?;
    Ok(value)
}

struct StrictSeed {
    /// Conteneurs déjà ouverts.
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for StrictSeed {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(StrictVisitor { depth: self.depth })
    }
}

struct StrictVisitor {
    depth: usize,
}

impl StrictVisitor {
    fn enter<E: de::Error>(&self) -> Result<usize, E> {
        if self.depth >= MAX_JSON_DEPTH {
            return Err(E::custom("profondeur maximale dépassée"));
        }
        Ok(self.depth + 1)
    }
}

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("une valeur JSON")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        if value.unsigned_abs() > MAX_SAFE {
            return Err(E::custom("nombre hors plage"));
        }
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        if value > MAX_SAFE {
            return Err(E::custom("nombre hors plage"));
        }
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        if !value.is_finite() || value.abs() > MAX_SAFE as f64 {
            return Err(E::custom("nombre hors plage"));
        }
        // Comme en JavaScript, `1.0`, `1e2` ou `-0` sont des entiers : on les normalise
        // pour que schémas, désérialisation typée et JCS voient la même valeur.
        if value.fract() == 0.0 {
            return Ok(Value::Number((value as i64).into()));
        }
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("nombre invalide"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let depth = self.enter()?;
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(StrictSeed { depth })? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let depth = self.enter()?;
        let mut object = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if object.contains_key(&key) {
                return Err(de::Error::custom(format!("clé dupliquée « {key} »")));
            }
            let value = map.next_value_seed(StrictSeed { depth })?;
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}
