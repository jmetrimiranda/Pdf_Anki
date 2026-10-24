//! Cost before a call (the worst case, reserved against the caps) and after it (the usage the API returned × the
//! price table). Plan 3.6.

use chrono::{DateTime, Utc};

use crate::prices::ModelPrice;
use crate::types::Usage;

const PER_MILLION: f64 = 1_000_000.0;

/// A conservative input estimate: characters ÷ 3 (real tokenizers average ~4 characters per token in English).
pub fn estimate_input_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(3)
}

/// The most a call can cost: every estimated input token at the input price plus the whole output cap (twice it when
/// it isn't verified that thinking counts in the cap) at the output price, with the most expensive tier.
pub fn worst_case_usd(
    price: &ModelPrice,
    at: DateTime<Utc>,
    input_tokens: u64,
    max_output_tokens: u32,
) -> f64 {
    let r = price.worst_rates(at, input_tokens);
    let out = u64::from(max_output_tokens) * u64::from(price.output_cap_factor());
    (input_tokens as f64 * r.input + out as f64 * r.output) / PER_MILLION
}

/// What a call cost, from the usage the API returned, at the price valid when it answered.
pub fn actual_usd(price: &ModelPrice, at: DateTime<Utc>, usage: &Usage) -> f64 {
    let prompt = usage.input + usage.cached_input + usage.cache_write;
    let r = price.rates_at(at, prompt);
    (usage.input as f64 * r.input
        + usage.cached_input as f64 * r.cached_input.unwrap_or(r.input)
        + usage.cache_write as f64 * r.cache_write.unwrap_or(r.input)
        + usage.output as f64 * r.output)
        / PER_MILLION
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prices::PriceTable;
    use crate::types::ProviderKind;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 24, 12, 0, 0).unwrap()
    }

    #[test]
    fn worst_case_and_actual_cost() {
        let t = PriceTable::built_in();
        let haiku = t.get(ProviderKind::Anthropic, "claude-haiku-5-5").unwrap();
        // 3 000 input tokens + 4 000 output at 0.10 / 0.50 per MTok.
        let worst = worst_case_usd(haiku, now(), 3_000, 4_000);
        assert!((worst - (3_000.0 * 0.10 + 4_000.0 * 0.50) / 1e6).abs() < 1e-12);
        let usage = Usage {
            input: 2_000,
            cached_input: 1_000,
            cache_write: 0,
            output: 1_500,
            thinking: 0,
        };
        let cost = actual_usd(haiku, now(), &usage);
        assert!((cost - (2_000.0 * 0.10 + 1_000.0 * 0.01 + 1_500.0 * 0.50) / 1e6).abs() < 1e-12);
        assert!(cost < worst);
    }

    #[test]
    fn unverified_thinking_doubles_the_reserved_output() {
        let t = PriceTable::built_in();
        let ds = t.get(ProviderKind::Deepseek, "deepseek-v4-pro").unwrap();
        let worst = worst_case_usd(ds, now(), 0, 2_000);
        // Peak output price 3.96, twice the 2 000-token cap.
        assert!((worst - 4_000.0 * 3.96 / 1e6).abs() < 1e-12);
    }

    #[test]
    fn input_estimate_is_conservative() {
        assert_eq!(estimate_input_tokens(""), 0);
        assert_eq!(estimate_input_tokens("abcd"), 2);
        assert_eq!(estimate_input_tokens("ação"), 2);
    }
}
