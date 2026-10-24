//! Spending caps summed over every provider (plan 3.6): US$ 1/day and US$ 5/month by default, a warning at 80%, a
//! hard stop at either cap, a confirmation above US$ 0.05 per call. The decision and the reservation happen under one
//! lock, so calls running in parallel can't overshoot a cap together.

use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::{AiError, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Caps {
    pub day_usd: f64,
    pub month_usd: f64,
    pub confirm_above_usd: f64,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            day_usd: 1.0,
            month_usd: 5.0,
            confirm_above_usd: 0.05,
        }
    }
}

/// What was already spent today and this month (local calendar), from `ai_usage`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Spent {
    pub day_usd: f64,
    pub month_usd: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetState {
    Ok,
    /// 80% or more of the day or month cap.
    Warning,
    /// A cap is reached: every AI call stops.
    Blocked,
}

/// How a call was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The user clicked; `confirmed` once they accepted a call above the confirmation threshold.
    Foreground { confirmed: bool },
    /// The background queue: never confirms by itself (plan 0.3).
    Background,
}

pub const WARN_RATIO: f64 = 0.8;

#[derive(Debug, Default)]
struct Inner {
    reserved: f64,
}

/// The shared reservation book. Clone it freely.
#[derive(Debug, Clone, Default)]
pub struct Budget {
    inner: Arc<Mutex<Inner>>,
}

/// A worst-case reservation; released when dropped (after the call is recorded).
#[derive(Debug)]
pub struct Reservation {
    budget: Budget,
    pub usd: f64,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut inner = self.budget.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.reserved = (inner.reserved - self.usd).max(0.0);
    }
}

impl Budget {
    pub fn reserved(&self) -> f64 {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .reserved
    }

    pub fn state(&self, caps: Caps, spent: Spent) -> BudgetState {
        let reserved = self.reserved();
        let day = spent.day_usd + reserved;
        let month = spent.month_usd + reserved;
        if day >= caps.day_usd || month >= caps.month_usd {
            BudgetState::Blocked
        } else if day >= caps.day_usd * WARN_RATIO || month >= caps.month_usd * WARN_RATIO {
            BudgetState::Warning
        } else {
            BudgetState::Ok
        }
    }

    /// Checks a call's worst case against both caps and the confirmation threshold, and reserves it.
    pub fn reserve(
        &self,
        caps: Caps,
        spent: Spent,
        worst_usd: f64,
        origin: Origin,
    ) -> Result<Reservation> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let day = spent.day_usd + inner.reserved;
        let month = spent.month_usd + inner.reserved;
        if day + worst_usd > caps.day_usd {
            return Err(AiError::LimitReached(limit_message(
                day,
                caps.day_usd,
                "hoje",
                "amanhã",
            )));
        }
        if month + worst_usd > caps.month_usd {
            return Err(AiError::LimitReached(limit_message(
                month,
                caps.month_usd,
                "neste mês",
                "no dia 1º",
            )));
        }
        let needs_confirmation = worst_usd > caps.confirm_above_usd;
        match origin {
            Origin::Foreground { confirmed: false } | Origin::Background if needs_confirmation => {
                return Err(AiError::NeedsConfirmation(worst_usd));
            }
            _ => {}
        }
        inner.reserved += worst_usd;
        drop(inner);
        Ok(Reservation {
            budget: self.clone(),
            usd: worst_usd,
        })
    }
}

fn limit_message(spent: f64, cap: f64, when: &str, back: &str) -> String {
    format!(
        "Limite de IA atingido: US$ {spent:.2} de US$ {cap:.2} {when}. As funções de IA voltam {back}, ou aumente o \
         limite em Configurações → IA. O resto do app continua funcionando."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPS: Caps = Caps {
        day_usd: 1.0,
        month_usd: 5.0,
        confirm_above_usd: 0.05,
    };
    const FG: Origin = Origin::Foreground { confirmed: false };

    #[test]
    fn blocks_a_call_that_would_pass_either_cap() {
        let b = Budget::default();
        let e = b
            .reserve(
                CAPS,
                Spent {
                    day_usd: 0.99,
                    month_usd: 1.0,
                },
                0.02,
                FG,
            )
            .unwrap_err();
        assert_eq!(e.code(), "ai_limit_reached");
        assert!(e.to_string().contains("hoje"));
        let e = b
            .reserve(
                CAPS,
                Spent {
                    day_usd: 0.0,
                    month_usd: 4.99,
                },
                0.02,
                FG,
            )
            .unwrap_err();
        assert!(e.to_string().contains("neste mês"));
        assert!(
            b.reserve(
                CAPS,
                Spent {
                    day_usd: 0.5,
                    month_usd: 1.0
                },
                0.02,
                FG
            )
            .is_ok()
        );
    }

    #[test]
    fn reservations_add_up_until_released() {
        let b = Budget::default();
        let spent = Spent {
            day_usd: 0.95,
            month_usd: 1.0,
        };
        let r1 = b.reserve(CAPS, spent, 0.03, FG).unwrap();
        // A second call in parallel would pass the day cap only together with the first one.
        assert!(b.reserve(CAPS, spent, 0.03, FG).is_err());
        drop(r1);
        assert!(b.reserve(CAPS, spent, 0.03, FG).is_ok());
    }

    #[test]
    fn confirmation_above_the_threshold() {
        let b = Budget::default();
        let spent = Spent::default();
        assert_eq!(
            b.reserve(CAPS, spent, 0.06, FG).unwrap_err().code(),
            "ai_needs_confirmation"
        );
        assert_eq!(
            b.reserve(CAPS, spent, 0.06, Origin::Background)
                .unwrap_err()
                .code(),
            "ai_needs_confirmation"
        );
        assert!(
            b.reserve(CAPS, spent, 0.06, Origin::Foreground { confirmed: true })
                .is_ok()
        );
        assert!(b.reserve(CAPS, spent, 0.05, Origin::Background).is_ok());
    }

    #[test]
    fn state_warns_at_80_percent_and_blocks_at_the_cap() {
        let b = Budget::default();
        assert_eq!(
            b.state(
                CAPS,
                Spent {
                    day_usd: 0.5,
                    month_usd: 1.0
                }
            ),
            BudgetState::Ok
        );
        assert_eq!(
            b.state(
                CAPS,
                Spent {
                    day_usd: 0.8,
                    month_usd: 1.0
                }
            ),
            BudgetState::Warning
        );
        assert_eq!(
            b.state(
                CAPS,
                Spent {
                    day_usd: 0.1,
                    month_usd: 4.0
                }
            ),
            BudgetState::Warning
        );
        assert_eq!(
            b.state(
                CAPS,
                Spent {
                    day_usd: 1.0,
                    month_usd: 1.0
                }
            ),
            BudgetState::Blocked
        );
    }
}
