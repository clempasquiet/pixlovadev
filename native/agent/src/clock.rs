//! Horloges (NAT-012) : instants UTC pour le calendrier, horloge monotone pour les durées.

use std::time::{SystemTime, UNIX_EPOCH};

/// Horloge murale injectable (tests d’expiration, d’horizon et d’horloge invalide).
pub trait Clock: Send + Sync {
    fn now_millis(&self) -> i64;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_millis(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// Date de construction minimale : une horloge antérieure est manifestement invalide.
/// Valeur fixe, mise à jour avec les releases (2026-09-01T00:00:00Z).
pub const MIN_VALID_EPOCH_MILLIS: i64 = 1_788_220_800_000;

pub fn clock_is_plausible(now_millis: i64) -> bool {
    now_millis >= MIN_VALID_EPOCH_MILLIS
}

/// Instant RFC 3339 UTC à la seconde, forme imposée par les contrats (`…Z`).
pub fn format_instant(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Instant RFC 3339 → millisecondes (formes acceptées par les contrats).
pub fn parse_instant_millis(text: &str) -> Option<i64> {
    pixlova_contracts::instant::parse_instant_micros(text).map(|micros| micros.div_euclid(1000))
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formate_et_relit_un_instant() {
        let millis = parse_instant_millis("2026-10-05T08:00:00Z").unwrap();
        assert_eq!(format_instant(millis), "2026-10-05T08:00:00Z");
        assert_eq!(format_instant(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            format_instant(parse_instant_millis("2028-02-29T23:59:59Z").unwrap()),
            "2028-02-29T23:59:59Z"
        );
    }

    #[test]
    fn detecte_une_horloge_invalide() {
        assert!(!clock_is_plausible(0));
        assert!(clock_is_plausible(
            parse_instant_millis("2026-10-01T00:00:00Z").unwrap()
        ));
    }
}
