#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod canonical_json;
mod daemon_record;
mod fs;
#[cfg(feature = "http")]
mod http;
mod identifier;
mod json_boundary;
mod redaction;
mod sentence;
mod sse;

pub use canonical_json::{Fingerprint, ParseFingerprintError, canonical_json};
pub use daemon_record::{
    DAEMON_RECORD_FILE, DEFAULT_HOME, DaemonRecord, DaemonRun, DaemonToken, ParseDaemonTokenError,
    ReadDaemonRecordError, read_daemon_record,
};
pub use fs::{
    DanglingLinks, FileStamp, LockedFile, PathEntry, ResolvePathError, append_line, canonical_path,
    create_directories, create_directory, create_new_file, describe_entry, file_stamp,
    list_directory, read_at_most, read_file, read_text_lossy, relative_path_if_contained,
    remove_directory, remove_file, sync_file, temporary_target, try_lock_file,
    write_file_atomically,
};
#[cfg(feature = "http")]
pub use http::{
    BASE_URL_RULE, BaseUrl, InvalidCredentialError, ParseBaseUrlError, credential_header,
    http_client,
};
pub use identifier::{Identifier, ParseIdentifierError};
pub use json_boundary::{
    BoundJsonError, Credentials, JsonLimits, bound_json, bound_json_object, redact_credentials,
    redact_object_credentials,
};
pub use redaction::is_credential_key;
pub use sentence::{error_chain, error_sentence, sentence};
pub use sse::{SseFrame, SseFrameSplitter};
