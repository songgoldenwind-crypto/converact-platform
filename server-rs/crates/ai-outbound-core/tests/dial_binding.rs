use converact_ai_outbound_core::{
    OutboundDialBinding, OutboundDialBindingError, OutboundDialBindingInput,
};

#[test]
fn dial_binding_is_bounded_and_redacted() {
    let binding = OutboundDialBinding::try_new(OutboundDialBindingInput {
        destination: "+8613800138000".to_owned(),
        caller_id: Some("+8610000000000".to_owned()),
        timeout_secs: 30,
        trunk: Some("carrier-a".to_owned()),
    })
    .unwrap();

    assert_eq!(binding.destination(), "+8613800138000");
    assert_eq!(binding.caller_id(), Some("+8610000000000"));
    assert_eq!(binding.timeout_secs(), 30);
    assert_eq!(binding.trunk(), Some("carrier-a"));
    let debug = format!("{binding:?}");
    assert!(!debug.contains("13800138000"));
    assert!(!debug.contains("10000000000"));
    assert!(!debug.contains("carrier-a"));
}

#[test]
fn dial_binding_rejects_unsafe_or_unbounded_values() {
    let invalid = |destination: &str, timeout_secs| {
        OutboundDialBinding::try_new(OutboundDialBindingInput {
            destination: destination.to_owned(),
            caller_id: None,
            timeout_secs,
            trunk: None,
        })
    };

    assert_eq!(
        invalid("+8613800138000\r\nX-Evil: yes", 30),
        Err(OutboundDialBindingError::InvalidDestination),
    );
    assert_eq!(
        invalid("+8613800138000", 0),
        Err(OutboundDialBindingError::InvalidTimeout),
    );
}
