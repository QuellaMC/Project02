/// A closed vocabulary: each value beside its one spelling, which the wire,
/// the records and the messages share. A crate that spells one depends on
/// serde, schemars and ts-rs, which describe it as it does.
#[macro_export]
macro_rules! vocabulary {
    (
        $(#[$meta:meta])*
        $name:ident { $($(#[$variant_meta:meta])* $variant:ident = $text:literal,)+ }
    ) => {
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash,
            serde::Serialize, serde::Deserialize, schemars::JsonSchema, ts_rs::TS,
        )]
        $(#[$meta])*
        pub enum $name {
            $($(#[$variant_meta])* #[serde(rename = $text)] $variant,)+
        }

        impl $name {
            /// Every value, in the contract's order.
            pub const ALL: &[Self] = &[$(Self::$variant,)+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text,)+
                }
            }

            /// The value spelled `text`, if the vocabulary has one.
            #[must_use]
            pub fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}
