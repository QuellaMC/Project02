//! Which provider a character speaks through.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use p02_contracts::RoleModelAdapter;

use crate::nvidia::{BuildNvidiaAdapterError, NvidiaAdapter, NvidiaSettings};
use crate::test_provider::DeterministicAdapter;

/// A test provider a test harness's switch can name. None is ever a
/// setting's value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TestProvider {
    /// Fixed replies, with no model or network behind them.
    Deterministic,
}

/// Why a switch's value names no test provider.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the test provider is \"deterministic\"")]
pub struct UnknownTestProviderError;

impl FromStr for TestProvider {
    type Err = UnknownTestProviderError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "deterministic" => Ok(Self::Deterministic),
            _ => Err(UnknownTestProviderError),
        }
    }
}

/// The provider a character speaks through: the test provider the switch
/// names, whatever the settings choose; else the provider the settings
/// chose, its silence bound shortened when the harness shortened it; else
/// none, until a provider is chosen.
///
/// # Errors
///
/// [`BuildNvidiaAdapterError`] when the chosen provider's settings cannot
/// make an adapter.
pub fn select_adapter(
    test_provider: Option<TestProvider>,
    nvidia: Option<&NvidiaSettings>,
    shortened_silence: Option<Duration>,
) -> Result<Option<Arc<dyn RoleModelAdapter>>, BuildNvidiaAdapterError> {
    if let Some(TestProvider::Deterministic) = test_provider {
        return Ok(Some(Arc::new(DeterministicAdapter)));
    }

    let Some(settings) = nvidia else {
        return Ok(None);
    };
    let adapter = NvidiaAdapter::new(settings)?;
    let adapter = match shortened_silence {
        Some(silence) => adapter.with_silence(silence),
        None => adapter,
    };

    Ok(Some(Arc::new(adapter)))
}
