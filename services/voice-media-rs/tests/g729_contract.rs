use rvoip_g729::{
    EncodedFrame, G729Decoder, G729Encoder, G729Error, G729FrameKind, G729Mode, G729Packetization,
    G729Payload, G729PayloadBuilder, DYNAMIC_PAYLOAD_TYPE_MAX, DYNAMIC_PAYLOAD_TYPE_MIN,
    FRAME_SAMPLES, MAX_PACKET_BYTES, MAX_SPEECH_FRAMES_PER_PACKET, SID_FRAME_BYTES,
    SPEECH_FRAME_BYTES, STATIC_PAYLOAD_TYPE, SUPPORTED_PACKETIZATION_MS, WIRE_CLOCK_RATE_HZ,
    WIRE_CODEC_ID, WIRE_ENCODING_NAME,
};

#[test]
fn one_wire_codec_has_two_internal_modes_and_six_packetizations() {
    assert_eq!(WIRE_CODEC_ID, "G729/8000");
    assert_eq!(WIRE_ENCODING_NAME, "G729");
    assert_eq!(WIRE_CLOCK_RATE_HZ, 8_000);
    assert_eq!(STATIC_PAYLOAD_TYPE, 18);
    assert_eq!(DYNAMIC_PAYLOAD_TYPE_MIN, 96);
    assert_eq!(DYNAMIC_PAYLOAD_TYPE_MAX, 127);
    assert_eq!(G729Mode::ALL, [G729Mode::G729A, G729Mode::G729AB]);
    assert_eq!(G729Mode::G729A.wire_codec_id(), WIRE_CODEC_ID);
    assert_eq!(G729Mode::G729AB.wire_codec_id(), WIRE_CODEC_ID);
    assert!(!G729Mode::G729A.annex_b_enabled());
    assert!(G729Mode::G729AB.annex_b_enabled());

    assert_eq!(SUPPORTED_PACKETIZATION_MS, [10, 20, 30, 40, 50, 60]);
    for (index, milliseconds) in SUPPORTED_PACKETIZATION_MS.into_iter().enumerate() {
        let packetization = G729Packetization::try_from_milliseconds(milliseconds).unwrap();
        assert_eq!(packetization.milliseconds(), milliseconds);
        assert_eq!(packetization.speech_frames(), index + 1);
    }
    for milliseconds in [0, 1, 9, 11, 15, 70, u16::MAX] {
        assert!(matches!(
            G729Packetization::try_from_milliseconds(milliseconds),
            Err(G729Error::UnsupportedPacketization {
                milliseconds: actual
            }) if actual == milliseconds
        ));
    }
}

#[test]
fn payload_parser_accepts_one_to_six_speech_frames_without_allocation() {
    let mut payload = [0_u8; MAX_PACKET_BYTES];
    for speech_frames in 1..=MAX_SPEECH_FRAMES_PER_PACKET {
        let speech_bytes = speech_frames * SPEECH_FRAME_BYTES;
        for (index, byte) in payload[..speech_bytes].iter_mut().enumerate() {
            *byte = index as u8;
        }
        for mode in G729Mode::ALL {
            let parsed = G729Payload::parse(mode, &payload[..speech_bytes]).unwrap();
            assert_eq!(parsed.speech_frame_count(), speech_frames);
            assert!(!parsed.has_sid());
            assert_eq!(parsed.as_bytes(), &payload[..speech_bytes]);
            for frame_index in 0..speech_frames {
                let start = frame_index * SPEECH_FRAME_BYTES;
                assert_eq!(
                    parsed.speech_frame(frame_index).unwrap(),
                    &payload[start..start + SPEECH_FRAME_BYTES]
                );
            }
            assert!(parsed.speech_frame(speech_frames).is_none());
            assert!(parsed.sid().is_none());
        }
    }
}

#[test]
fn annex_b_payload_accepts_only_one_optional_final_sid() {
    let mut payload = [0_u8; MAX_PACKET_BYTES];
    for speech_frames in 0..=MAX_SPEECH_FRAMES_PER_PACKET {
        let speech_bytes = speech_frames * SPEECH_FRAME_BYTES;
        payload[..speech_bytes].fill(0x55);
        payload[speech_bytes..speech_bytes + SID_FRAME_BYTES].copy_from_slice(&[0x12, 0x34]);
        let packet_bytes = speech_bytes + SID_FRAME_BYTES;

        let parsed = G729Payload::parse(G729Mode::G729AB, &payload[..packet_bytes]).unwrap();
        assert_eq!(parsed.speech_frame_count(), speech_frames);
        assert!(parsed.has_sid());
        assert_eq!(parsed.sid().unwrap(), &[0x12, 0x34]);
        assert_eq!(parsed.as_bytes(), &payload[..packet_bytes]);

        assert!(matches!(
            G729Payload::parse(G729Mode::G729A, &payload[..packet_bytes]),
            Err(G729Error::SidForbiddenInG729A)
        ));
    }
}

#[test]
fn payload_and_decoder_reject_unknown_lengths_instead_of_treating_them_as_no_data() {
    let bytes = [0_u8; MAX_PACKET_BYTES + 8];
    for length in [0, 1, 3, 9, 11, 13, 19, 21, 61, 63, 70] {
        let result = G729Payload::parse(G729Mode::G729AB, &bytes[..length]);
        if length == 0 {
            assert!(matches!(result, Err(G729Error::NoDataHasNoPacket)));
        } else {
            assert!(matches!(
                result,
                Err(G729Error::InvalidPayloadLength { bytes: actual })
                    if actual == length
            ));
        }
    }

    let mut output = [0_i16; FRAME_SAMPLES];
    let mut annex_a = G729Decoder::new(G729Mode::G729A);
    let mut annex_ab = G729Decoder::new(G729Mode::G729AB);
    assert!(matches!(
        annex_ab.decode_frame(&[], &mut output),
        Err(G729Error::NoDataHasNoPacket)
    ));
    assert!(matches!(
        annex_ab.decode_frame(&[0_u8; 11], &mut output),
        Err(G729Error::InvalidFrameLength { bytes: 11 })
    ));
    assert!(matches!(
        annex_a.decode_frame(&[0_u8; SID_FRAME_BYTES], &mut output),
        Err(G729Error::SidForbiddenInG729A)
    ));

    annex_ab.decode_erasure(&mut output);
}

#[test]
fn payload_builder_is_bounded_and_keeps_sid_last() {
    let speech = [0x5a_u8; SPEECH_FRAME_BYTES];
    let sid = [0xa5_u8; SID_FRAME_BYTES];
    let mut output = [0_u8; MAX_PACKET_BYTES];
    {
        let mut builder = G729PayloadBuilder::new(G729Mode::G729AB, &mut output);
        for _ in 0..MAX_SPEECH_FRAMES_PER_PACKET {
            builder.push_speech(&speech).unwrap();
        }
        builder.push_sid(&sid).unwrap();
        let payload = builder.finish().unwrap();
        assert_eq!(
            payload.as_bytes().len(),
            MAX_SPEECH_FRAMES_PER_PACKET * SPEECH_FRAME_BYTES + SID_FRAME_BYTES
        );
        assert_eq!(payload.speech_frame_count(), MAX_SPEECH_FRAMES_PER_PACKET);
        assert_eq!(payload.sid().unwrap(), &sid);
    }

    let mut output = [0_u8; MAX_PACKET_BYTES];
    let mut builder = G729PayloadBuilder::new(G729Mode::G729AB, &mut output);
    builder.push_sid(&sid).unwrap();
    assert!(matches!(
        builder.push_speech(&speech),
        Err(G729Error::SidMustBeLast)
    ));
    assert!(matches!(
        builder.push_sid(&sid),
        Err(G729Error::MultipleSidFrames)
    ));

    let mut output = [0_u8; MAX_PACKET_BYTES];
    let mut annex_a = G729PayloadBuilder::new(G729Mode::G729A, &mut output);
    assert!(matches!(
        annex_a.push_sid(&sid),
        Err(G729Error::SidForbiddenInG729A)
    ));
    assert!(matches!(
        annex_a.finish(),
        Err(G729Error::NoDataHasNoPacket)
    ));
}

#[test]
fn codec_adapter_uses_caller_owned_fixed_buffers_and_explicit_erasure() {
    fn encoder_signature(
        _: fn(
            &mut G729Encoder,
            &[i16; FRAME_SAMPLES],
            &mut [u8; SPEECH_FRAME_BYTES],
        ) -> EncodedFrame,
    ) {
    }
    fn decoder_signature(
        _: fn(
            &mut G729Decoder,
            &[u8],
            &mut [i16; FRAME_SAMPLES],
        ) -> Result<G729FrameKind, G729Error>,
    ) {
    }
    encoder_signature(G729Encoder::encode_frame);
    decoder_signature(G729Decoder::decode_frame);

    let pcm = core::array::from_fn(|index| (index as i16).saturating_mul(128));
    let mut encoded = [0_u8; SPEECH_FRAME_BYTES];
    let mut encoder = G729Encoder::new(G729Mode::G729A);
    let frame = encoder.encode_frame(&pcm, &mut encoded);
    assert_eq!(encoder.mode(), G729Mode::G729A);
    assert_eq!(frame.kind(), G729FrameKind::Speech);
    assert_eq!(frame.byte_len(), SPEECH_FRAME_BYTES);

    let mut decoded = [0_i16; FRAME_SAMPLES];
    let mut decoder = G729Decoder::new(G729Mode::G729AB);
    assert_eq!(
        decoder
            .decode_frame(&[0_u8; SPEECH_FRAME_BYTES], &mut decoded)
            .unwrap(),
        G729FrameKind::Speech
    );
    assert_eq!(
        decoder
            .decode_frame(&[0_u8; SID_FRAME_BYTES], &mut decoded)
            .unwrap(),
        G729FrameKind::Sid
    );
    decoder.decode_erasure(&mut decoded);
}
