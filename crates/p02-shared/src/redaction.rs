/// Whether a key names a credential, so its value must not be kept. Only the
/// name classifies, never the value, and the name is read as its lowercase
/// ASCII letters and digits: `apiKey`, `api_key` and `API-KEY` are one name.
/// A token count such as `prompt_tokens` ends in `tokens` and is not one.
#[must_use]
pub fn is_credential_key(key: &str) -> bool {
    let name: String = key
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();

    NAMES.contains(&name.as_str())
        || PARTS.iter().any(|part| name.contains(part))
        || SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

const NAMES: [&str; 5] = [
    "authorization",
    "cookie",
    "proxyauthorization",
    "secretkey",
    "setcookie",
];

const PARTS: [&str; 10] = [
    "accesskey",
    "accesstoken",
    "apikey",
    "clientsecret",
    "credential",
    "passphrase",
    "password",
    "privatekey",
    "refreshtoken",
    "sessionkey",
];

const SUFFIXES: [&str; 2] = ["secret", "token"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_a_credential_by_the_shape_of_its_name() {
        for (key, credential) in [
            ("Authorization", true),
            ("Proxy-Authorization", true),
            ("Set-Cookie", true),
            ("secret_key", true),
            ("x-api-key", true),
            ("OPENAI_API_KEY", true),
            ("refreshToken", true),
            ("aws_secret_access_key", true),
            ("db_password", true),
            ("credentials", true),
            ("bot_token", true),
            ("webhookSecret", true),
            ("prompt_tokens", false),
            ("total_tokens", false),
            ("token_count", false),
            ("tokenizer", false),
            ("secretary", false),
            ("cookies_accepted", false),
            ("name", false),
        ] {
            assert_eq!(is_credential_key(key), credential, "{key}");
        }
    }
}
