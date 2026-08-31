use converact_rustpbx_rwi_adapter::{
    AddAgentLegRequest, BridgeRequest, InspectCallRequest, OriginateRequest, RwiCommand,
    encode_command,
};

#[test]
fn inspect_call_uses_the_constant_time_pinned_rustpbx_wire() {
    let inspect = encode_command(RwiCommand::InspectCall(InspectCallRequest {
        action_id: "query-001".to_owned(),
        call_id: "call-001".to_owned(),
    }))
    .unwrap();

    assert_eq!(inspect["action"], "session.inspect_call");
    assert_eq!(inspect["params"]["call_id"], "call-001");
}

#[test]
fn originate_uses_the_exact_pinned_rustpbx_wire_without_agent_headers() {
    let originate = encode_command(RwiCommand::Originate(OriginateRequest {
        action_id: "attempt-001:originate".to_owned(),
        call_id: "call-001".to_owned(),
        destination: "+8613800138000".to_owned(),
        caller_id: Some("+8610000000000".to_owned()),
        timeout_secs: 30,
        trunk: Some("carrier-a".to_owned()),
    }))
    .unwrap();
    assert_eq!(originate["action"], "call.originate");
    assert_eq!(originate["action_id"], "attempt-001:originate");
    assert_eq!(originate["params"]["call_id"], "call-001");
    assert_eq!(originate["params"]["destination"], "+8613800138000");
    assert_eq!(originate["params"]["caller_id"], "+8610000000000");
    assert_eq!(originate["params"]["timeout_secs"], 30);
    assert_eq!(originate["params"]["trunk"], "carrier-a");
    assert_eq!(originate["params"]["extra_headers"], serde_json::json!({}));
}

#[test]
fn only_the_internal_agent_leg_carries_the_bounded_session_binding() {
    let leg = encode_command(RwiCommand::AddAgentLeg(AddAgentLegRequest {
        action_id: "attempt-001:agent-leg".to_owned(),
        call_id: "call-001".to_owned(),
        target: "sip:agent@active-call.internal:5060".to_owned(),
        leg_id: "leg-agent-001".to_owned(),
        agent_session_id: "ac.session-001".to_owned(),
    }))
    .unwrap();

    assert_eq!(leg["action"], "call.leg_add");
    assert_eq!(leg["params"]["call_id"], "call-001");
    assert_eq!(
        leg["params"]["target"],
        "sip:agent@active-call.internal:5060"
    );
    assert_eq!(leg["params"]["leg_id"], "leg-agent-001");
    assert_eq!(leg["params"]["agent_session_id"], "ac.session-001");
    assert!(leg["params"].get("extra_headers").is_none());
}

#[test]
fn agent_leg_rejects_header_injection_and_non_sip_targets() {
    let request = |target: &str, agent_session_id: &str| {
        RwiCommand::AddAgentLeg(AddAgentLegRequest {
            action_id: "attempt-001:agent-leg".to_owned(),
            call_id: "call-001".to_owned(),
            target: target.to_owned(),
            leg_id: "leg-agent-001".to_owned(),
            agent_session_id: agent_session_id.to_owned(),
        })
    };

    let injected = encode_command(request(
        "sip:agent@active-call.internal:5060",
        "ac.session-001\r\nX-Injected: yes",
    ));
    assert_eq!(injected.unwrap_err().code(), "rustpbx_identifier_invalid");

    let wrong_transport = encode_command(request("https://active-call.internal", "ac.session-001"));
    assert_eq!(
        wrong_transport.unwrap_err().code(),
        "rustpbx_destination_invalid"
    );
}

#[test]
fn bridge_uses_the_frozen_rwi_v1_action() {
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
