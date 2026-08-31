use converact_rustpbx_rwi_adapter::{BridgeRequest, OriginateRequest, RwiCommand, encode_command};

#[test]
fn originate_and_bridge_use_the_frozen_rwi_v1_actions() {
    let originate = encode_command(RwiCommand::Originate(OriginateRequest {
        action_id: "attempt-001:originate".to_owned(),
        to: "+8613800138000".to_owned(),
        from: Some("+8610000000000".to_owned()),
        timeout_seconds: 30,
        interaction_id: "interaction-001".to_owned(),
    }))
    .unwrap();
    assert_eq!(originate["action"], "call.originate");
    assert_eq!(originate["action_id"], "attempt-001:originate");
    assert_eq!(originate["params"]["to"], "+8613800138000");

    let bridge = encode_command(RwiCommand::Bridge(BridgeRequest {
        action_id: "attempt-001:bridge".to_owned(),
        leg_a: "leg-customer".to_owned(),
        leg_b: "leg-active-call".to_owned(),
    }))
    .unwrap();
    assert_eq!(bridge["action"], "call.bridge");
    assert_eq!(bridge["params"]["leg_a"], "leg-customer");
    assert_eq!(bridge["params"]["leg_b"], "leg-active-call");
}

#[test]
fn bridge_rejects_the_same_leg_twice() {
    let result = encode_command(RwiCommand::Bridge(BridgeRequest {
        action_id: "attempt-001:bridge".to_owned(),
        leg_a: "leg-a".to_owned(),
        leg_b: "leg-a".to_owned(),
    }));
    assert_eq!(result.unwrap_err().code(), "rustpbx_bridge_legs_invalid");
}

#[test]
fn arbitrary_actions_fail_closed_as_unavailable_capabilities() {
    let result = encode_command(RwiCommand::Unsupported {
        action: "call.execute_arbitrary".to_owned(),
    });

    assert_eq!(result.unwrap_err().code(), "capability_unavailable");
}
