//! Durable `PostgreSQL` statements for Tool Action authority.

#![forbid(unsafe_code)]

mod postgres;

pub use postgres::{ToolActionSqlStore, ToolActionStoreConfig, ToolStoreError};
