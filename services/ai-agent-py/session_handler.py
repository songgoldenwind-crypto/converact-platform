from __future__ import annotations

import asyncio
import json
import logging

import numpy as np
from livekit.agents import Agent, AgentSession, JobContext, JobProcess, WorkerOptions, cli
from livekit.plugins import silero

from livekit_audio_tap_transport import start_configured_livekit_audio_tap
from converact_client import ConveractClient
from plugins.llm_config import get_llm
from plugins.provider_runtime import build_session_connect_options
from plugins.stt_selector import select_stt
from plugins.tts_selector import select_tts
from realtime_pipeline import (
    aec_warmup_seconds,
    build_turn_handling,
    extract_conversation_turn,
    extract_voice_latency_observations,
    vad_load_options,
)
from scripts.spec_loader import resolve_agent_spec
from tool_context import ToolContext
from tools import (
    check_compliance,
    check_intent,
    disclosure_complete,
    generate_summary,
    get_campaign_script,
    navigate_flow,
    query_knowledge,
    report_call_outcome,
    schedule_callback,
    send_material,
    transfer_human,
)
from voice_latency_metrics import (
    prometheus_port,
    record_voice_latency_observations,
    start_voice_latency_metrics_server,
)

logger = logging.getLogger("ai-agent")

DEFAULT_TOOLS = [
    "check_compliance",
    "disclosure_complete",
    "check_intent",
    "transfer_human",
    "schedule_callback",
    "send_material",
]

INBOUND_TOOLS = [
    "check_intent",
    "transfer_human",
    "query_knowledge",
    "generate_summary",
]

OUTBOUND_CAMPAIGN_TOOLS = [
    "check_compliance",
    "disclosure_complete",
    "check_intent",
    "transfer_human",
    "get_campaign_script",
    "report_call_outcome",
    "generate_summary",
]


def prewarm_process(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load(**vad_load_options({"media_source": "sip"}))


def build_tool(ctx: ToolContext, name: str):
    if name == "check_compliance":
        customer = ctx.room_meta.get("customer") if isinstance(ctx.room_meta.get("customer"), dict) else {}
        phone = str(customer.get("phone") or ctx.room_meta.get("phone_number") or "")
        timezone = str(ctx.room_meta.get("timezone") or "Asia/Shanghai")
        return check_compliance.create(ctx.converact, ctx.tenant_id, phone, timezone)
    if name == "disclosure_complete":
        return disclosure_complete.create(ctx.converact, ctx.call_session_id, ctx.tenant_id)
    if name == "check_intent":
        return check_intent.create(ctx.converact, ctx.call_session_id, ctx.language)
    if name == "transfer_human":
        return transfer_human.create(
            ctx.converact, ctx.ctx.room.name, ctx.tenant_id, ctx.call_session_id, ctx.language
        )
    if name == "schedule_callback":
        return schedule_callback.create(ctx.converact, ctx.ctx.room.name, ctx.tenant_id, ctx.language)
    if name == "send_material":
        return send_material.create(ctx.converact, ctx.tenant_id)
    if name == "query_knowledge":
        return query_knowledge.create(ctx)
    if name == "generate_summary":
        return generate_summary.create(ctx)
    if name == "get_campaign_script":
        return get_campaign_script.create(ctx)
    if name == "report_call_outcome":
        return report_call_outcome.create(ctx)
    if name == "navigate_flow":
        return navigate_flow.create(ctx)
    return None


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    converact = ConveractClient()
    audio_tap = None

    async def shutdown_runtime() -> None:
        if audio_tap is not None:
            await audio_tap.stop()
        await converact.aclose()

    ctx.add_shutdown_callback(shutdown_runtime)

    try:
        room_meta = json.loads(ctx.room.metadata or "{}")
        script_id = room_meta.get("script_id", "default")
        agent_spec_id = str(room_meta.get("agent_spec_id") or "")
        language = room_meta.get("language", "zh")
        tenant_id = room_meta.get("tenant_id", "")
        call_session_id = room_meta.get("call_session_id", "")
        current_node_id = room_meta.get("current_node_id")

        try:
            audio_tap = await start_configured_livekit_audio_tap(
                room=ctx.room,
                metadata=room_meta,
                converact=converact,
                on_event=_observe_audio_tap_event,
            )
        except Exception as error:
            logger.warning(
                "LiveKit audio tap unavailable; continuing primary media: %s",
                type(error).__name__,
            )

        script, spec = await resolve_agent_spec(
            converact=converact,
            agent_spec_id=agent_spec_id or None,
            script_id=script_id,
            language=language,
        )

        if spec and spec.nodes and call_session_id and agent_spec_id:
            try:
                nav = await converact.navigate_flow(
                    call_session_id=call_session_id,
                    agent_spec_id=agent_spec_id,
                    trigger="start",
                )
                current_node_id = nav.get("current_node_id") or current_node_id
            except Exception as error:
                logger.warning("failed to init navigation: %s", error)

        enabled_tools = room_meta.get("tools")
        if not isinstance(enabled_tools, list):
            direction = str(room_meta.get("direction") or room_meta.get("call_direction") or "outbound")
            has_campaign = bool(room_meta.get("campaign_id"))
            if has_campaign:
                enabled_tools = list(OUTBOUND_CAMPAIGN_TOOLS)
            else:
                enabled_tools = list(INBOUND_TOOLS if direction == "inbound" else DEFAULT_TOOLS)
        if spec and spec.nodes and "navigate_flow" not in enabled_tools:
            enabled_tools = [*enabled_tools, "navigate_flow"]
        if "query_knowledge" not in enabled_tools:
            enabled_tools = [*enabled_tools, "query_knowledge"]

        tool_ctx = ToolContext(
            converact=converact,
            ctx=ctx,
            tenant_id=tenant_id,
            call_session_id=call_session_id,
            language=language,
            agent_spec_id=agent_spec_id,
            room_meta=room_meta if isinstance(room_meta, dict) else {},
        )
        tools = [tool for name in enabled_tools if (tool := build_tool(tool_ctx, name))]

        instructions = (
            spec.build_instructions(str(current_node_id) if current_node_id else None)
            if spec
            else script.system_prompt
        )

        avatar_session_key = (call_session_id or str(ctx.room.name)).strip() or None
        from avatar.audio_feed import bind_avatar_audio_session, register_avatar_audio_feed

        async def _release_avatar_audio_feed() -> None:
            if avatar_session_key:
                register_avatar_audio_feed(avatar_session_key, None)
            bind_avatar_audio_session(None)

        if avatar_session_key:
            bind_avatar_audio_session(avatar_session_key)
            ctx.add_shutdown_callback(_release_avatar_audio_feed)

        vad = ctx.proc.userdata.get("vad")
        if vad is None:
            logger.warning("worker VAD was not prewarmed; loading in session")
            vad = silero.VAD.load(**vad_load_options(room_meta))

        session = AgentSession(
            vad=vad,
            stt=select_stt(language, vad=vad),
            llm=get_llm(),
            tts=select_tts(language, avatar_session_key=avatar_session_key),
            turn_handling=build_turn_handling(room_meta),
            aec_warmup_duration=aec_warmup_seconds(room_meta),
            conn_options=build_session_connect_options(),
        )

        agent = Agent(instructions=instructions, tools=tools)

        @session.on("conversation_item_added")
        def on_conversation_item(ev) -> None:
            try:
                record_voice_latency_observations(
                    extract_voice_latency_observations(
                        ev,
                        media_source=room_meta.get("media_source"),
                    )
                )
            except Exception:
                logger.warning(
                    "voice latency observation failed; continuing session",
                    exc_info=True,
                )
            turn = extract_conversation_turn(ev)
            if turn is None:
                return
            logger.info(
                "voice turn committed role=%s interrupted=%s latency_ms=%s",
                turn["role"],
                turn["interrupted"],
                turn.get("latency_ms"),
            )
            asyncio.create_task(
                converact.report_turn(
                    call_session_id,
                    turn["role"],
                    turn["content"],
                    stt_confidence=turn.get("stt_confidence"),
                    latency_ms=turn.get("latency_ms"),
                )
            )

        await session.start(agent=agent, room=ctx.room)

        # --- Avatar video track (digital human) ---
        # When the room metadata has avatar_enabled=true, initialize and
        # publish a MuseTalk-driven video track so the customer sees a
        # talking digital human instead of just hearing audio.
        avatar_enabled = bool(room_meta.get("avatar_enabled"))
        avatar = None
        if avatar_enabled:
            try:
                from avatar import load_avatar_config
                from avatar.musetalk_runner import MuseTalkRunner
                from avatar.video_source import AvatarVideoSource

                avatar_config = load_avatar_config()
                runner = MuseTalkRunner(avatar_config)
                await runner.load()
                avatar = AvatarVideoSource(avatar_config, runner)
                await avatar.publish(ctx.room)
                await avatar.start()
                logger.info("Avatar video track published for call %s", call_session_id)
            except Exception:
                logger.warning("Avatar initialization failed, continuing audio-only", exc_info=True)
                avatar = None

        if avatar is not None and avatar_session_key:
            import numpy as np
            from avatar.audio_feed import register_avatar_audio_feed

            def _on_tts_pcm(pcm_bytes: bytes, sample_rate: int) -> None:
                if avatar is None:
                    return
                audio_i16 = np.frombuffer(pcm_bytes, dtype=np.int16)
                if audio_i16.size == 0:
                    return
                audio_f32 = audio_i16.astype(np.float32) / 32768.0
                target_sr = 16000
                if sample_rate != target_sr:
                    out_len = max(1, int(len(audio_f32) * target_sr / sample_rate))
                    indices = np.linspace(0, len(audio_f32) - 1, out_len)
                    audio_f32 = np.interp(indices, np.arange(len(audio_f32)), audio_f32)
                avatar.feed_audio(audio_f32)

            register_avatar_audio_feed(avatar_session_key, _on_tts_pcm)

            async def _stop_avatar_video() -> None:
                await avatar.stop()

            ctx.add_shutdown_callback(_stop_avatar_video)

            @session.on("agent_state_changed")
            def on_agent_state_changed(event) -> None:
                avatar.set_speaking(event.new_state == "speaking")

        from llm_client import aclose_llm_http

        ctx.add_shutdown_callback(aclose_llm_http)

        # Play AI disclosure announcement BEFORE business greeting.
        # Compliance requires: "これはAIによる自動音声です" (or equivalent)
        # must be spoken before any business conversation.
        # disclosure_config is set by outbound-dialer.ts beginDisclosure()
        # and passed via LiveKit room metadata.
        disclosure_config = room_meta.get("disclosure_config")
        if isinstance(disclosure_config, dict):
            disclosure_text = disclosure_config.get("text") or ""
            if disclosure_text:
                try:
                    await session.generate_reply(instructions=disclosure_text)
                    logger.info("disclosure announcement played for call %s", call_session_id)
                except Exception:
                    logger.warning("failed to play disclosure announcement")
            else:
                logger.debug("no disclosure text in config, skipping")
        else:
            # No disclosure_config in room metadata — this may be an inbound
            # call or a legacy outbound without disclosure enforcement.
            logger.debug("no disclosure_config in room metadata")

        # Play business greeting after disclosure.
        await session.generate_reply(instructions=script.greeting)
    except Exception:
        logger.exception("ai-agent session failed")
        raise


def _observe_audio_tap_event(event: dict) -> None:
    event_type = str(event.get("type") or "unknown")
    reason = str(event.get("reason") or "")
    dropped_ms = int(event.get("dropped_duration_ms") or 0)
    if event_type.endswith(("failed", "control_failed")):
        logger.warning(
            "LiveKit audio tap event type=%s reason=%s",
            event_type,
            reason,
        )
    else:
        logger.debug(
            "LiveKit audio tap event type=%s reason=%s dropped_ms=%d",
            event_type,
            reason,
            dropped_ms,
        )


def main() -> None:
    try:
        start_voice_latency_metrics_server()
    except OSError as error:
        logger.warning(
            "voice latency metrics collector unavailable; continuing worker: %s",
            type(error).__name__,
        )
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm_process,
            agent_name="ai-agent",
            prometheus_port=prometheus_port(),
        )
    )


if __name__ == "__main__":
    main()
