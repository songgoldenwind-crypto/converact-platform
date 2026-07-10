-- Drop orphan Phase 5C circuit-breaker tables (no writers; analytics hardcodes 0).
DROP TABLE IF EXISTS circuit_breaker_events;
DROP TABLE IF EXISTS circuit_breaker_state;
