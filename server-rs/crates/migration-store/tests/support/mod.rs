use converact_kernel_ids::Generation;
use converact_migration_routing::{OperationId, RequestHash, RouteRevision};

pub fn operation(value: &str) -> OperationId {
    OperationId::parse(value).unwrap()
}

pub fn hash(value: char) -> RequestHash {
    RequestHash::parse(&value.to_string().repeat(64)).unwrap()
}

pub fn generation(value: u64) -> Generation {
    Generation::new(value).unwrap()
}

pub fn revision(value: u64) -> RouteRevision {
    RouteRevision::new(value).unwrap()
}
