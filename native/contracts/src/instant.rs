//! Instants RFC 3339 UTC (`YYYY-MM-DDTHH:MM:SS[.ffffff]Z`) en microsecondes Unix,
//! calcul identique à `packages/contracts/src/instant.ts`.

fn digits(bytes: &[u8]) -> Option<i64> {
    bytes.iter().try_fold(0i64, |acc, byte| {
        byte.is_ascii_digit()
            .then(|| acc * 10 + i64::from(byte - b'0'))
    })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// `None` si la chaîne n’est pas un instant valide (mois 13, 30 février, seconde 60…).
pub fn parse_instant_micros(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes.last() != Some(&b'Z') {
        return None;
    }
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if separators
        .iter()
        .any(|&(index, expected)| bytes[index] != expected)
    {
        return None;
    }
    let year = digits(&bytes[0..4])?;
    let month = digits(&bytes[5..7])?;
    let day = digits(&bytes[8..10])?;
    let hour = digits(&bytes[11..13])?;
    let minute = digits(&bytes[14..16])?;
    let second = digits(&bytes[17..19])?;
    let fraction = match &bytes[19..bytes.len() - 1] {
        [] => 0,
        [b'.', rest @ ..] if (1..=6).contains(&rest.len()) => {
            digits(rest)? * 10i64.pow(6 - rest.len() as u32)
        }
        _ => return None,
    };
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(seconds * 1_000_000 + fraction)
}
