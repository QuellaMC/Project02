//! Which provider a character speaks through.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use p02_contracts::RoleModelAdapter;

use crate::nvidia::{NvidiaAdapter, NvidiaSettings};
use crate::responses::{OpenaiSettings, ResponsesAdapter};
use crate::test_provider::DeterministicAdapter;
use crate::transport::{BuildAdapterError, PROVIDER_SILENCE};

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

/// The service a character's settings choose, with what they set of it.
#[derive(Clone, Debug)]
pub enum ServiceSettings {
    Nvidia(NvidiaSettings),
    Openai(OpenaiSettings),
}

/// The provider a character speaks through: the test provider the switch
/// names, whatever the settings choose; else the service the settings
/// chose, its silence bound shortened when the harness shortened it; else
/// none, until a service is chosen.
///
/// # Errors
///
/// [`BuildAdapterError`] when the chosen service's settings cannot make an
/// adapter.
pub fn select_adapter(
    test_provider: Option<TestProvider>,
    service: Option<&ServiceSettings>,
    shortened_silence: Option<Duration>,
) -> Result<Option<Arc<dyn RoleModelAdapter>>, BuildAdapterError> {
    if let Some(TestProvider::Deterministic) = test_provider {
        return Ok(Some(Arc::new(DeterministicAdapter)));
    }

    let Some(service) = service else {
        return Ok(None);
    };
    let silence = shortened_silence.unwrap_or(PROVIDER_SILENCE);

    Ok(Some(match service {
        ServiceSettings::Nvidia(settings) => Arc::new(NvidiaAdapter::new(settings, silence)?),
        ServiceSettings::Openai(settings) => Arc::new(ResponsesAdapter::openai(settings, silence)?),
    }))
}
