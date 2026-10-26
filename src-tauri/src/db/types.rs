use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    /// TLS with full certificate and hostname verification.
    #[serde(rename = "verify-full")]
    VerifyFull,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum PasswordMode {
    /// Stored in the OS keychain / credential manager / secret service.
    #[default]
    Keychain,
    /// Never stored; asked for on every connect.
    Ask,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub driver: Driver,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub password_mode: PasswordMode,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub tag: String,
    /// Connection group shown in the welcome list ("" = ungrouped).
    #[serde(default)]
    pub group: String,
    /// SQL run right after connecting (e.g. SET statements).
    #[serde(default)]
    pub bootstrap: String,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// Private key file; when empty, password auth is used.
    #[serde(default)]
    pub key_path: Option<String>,
    /// SSH password, or the private key passphrase. Never written to disk (kept in the keychain).
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    /// SHA256 host key fingerprint, recorded on first connect.
    #[serde(default)]
    pub host_key: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows affected for non-SELECT statements.
    pub affected: Option<u64>,
    pub elapsed_ms: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ObjectList {
    pub tables: Vec<String>,
    pub views: Vec<String>,
    pub functions: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForeignRef {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub position: i64,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
    pub extra: Option<String>,
    pub is_primary: bool,
    pub foreign: Option<ForeignRef>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub algorithm: String,
    pub unique: bool,
    pub primary: bool,
    pub columns: String,
    pub condition: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub primary_key: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub op: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    pub schema: String,
    pub table: String,
    pub limit: u64,
    pub offset: u64,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub raw_where: Option<String>,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default)]
    pub order_desc: bool,
    /// Multi-column sort; takes precedence over `order_by`.
    #[serde(default)]
    pub sorts: Vec<SortSpec>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub table: String,
    pub count: u64,
    /// WHERE clause that reproduces the match, for opening the table filtered.
    pub where_sql: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub result: QueryResult,
    pub total: u64,
    /// True when `total` is the planner's estimate (very large tables).
    pub estimated: bool,
    pub sql: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct CellValue {
    pub column: String,
    pub value: Option<String>,
    /// Use the column's DEFAULT instead of `value`.
    #[serde(default)]
    pub default: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Update,
    Insert,
    Delete,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Change {
    pub kind: ChangeKind,
    pub schema: String,
    pub table: String,
    /// Identifies the row (primary key columns, or every column when the table has no key).
    #[serde(default)]
    pub key: Vec<CellValue>,
    /// New values (update: changed columns only; insert: provided columns).
    #[serde(default)]
    pub values: Vec<CellValue>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub connection: ConnectionConfig,
    pub server_version: String,
    pub schema: String,
}
