#[derive(Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/bindings/")]
pub struct CommandError {
    code: String,
    message: String,
}

impl CommandError {
    pub fn git(message: impl Into<String>) -> Self {
        Self {
            code: "git_error".into(),
            message: message.into(),
        }
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self {
            code: "runtime_error".into(),
            message: message.into(),
        }
    }
}
