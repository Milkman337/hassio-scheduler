"""The heating engine.

Resolves each enabled heating program's target temperature every minute
(schedule grid, or an active boost/hold override) and pushes it to the
program's climate entities via climate.set_temperature - but only when the
value actually changes, so we don't spam the entity with redundant calls.

Overrides carry their own expiry ("until") and are cleared automatically by
the same minute tick that resolves temperatures, so a boost/hold survives an
HA restart and still expires on time without needing a separate timer.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
import homeassistant.util.dt as dt_util

from .const import EVENT_HEATING_APPLIED, SIGNAL_HEATING_UPDATED, WEEKDAYS
from .heating_store import HeatingStore

_LOGGER = logging.getLogger(__name__)


def _minutes(hhmm: str | None) -> int | None:
    if not hhmm:
        return None
    try:
        h, m = hhmm.split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, TypeError):
        return None


def _find_preset(program: dict[str, Any], preset_id: str | None) -> dict[str, Any] | None:
    if not preset_id:
        return None
    for preset in program.get("presets", []):
        if preset.get("id") == preset_id:
            return preset
    return None


def _segment_for(program: dict[str, Any], weekday: str, minutes_now: int) -> dict[str, Any] | None:
    for seg in program.get("grid", {}).get(weekday, []):
        start = _minutes(seg.get("start"))
        end = _minutes(seg.get("end"))
        if start is None or end is None:
            continue
        if start <= minutes_now < end:
            return seg
    return None


def resolve_target_temperature(program: dict[str, Any], now_local: datetime) -> tuple[float | None, str]:
    """Return (temperature, source label) for a program at a given local time."""
    override = program.get("override")
    if override:
        until_raw = override.get("until")
        until_dt = dt_util.parse_datetime(until_raw) if until_raw else None
        if until_dt is None or now_local < until_dt:
            return override.get("temperature"), override.get("type", "override")

    weekday = WEEKDAYS[now_local.weekday()]
    minutes_now = now_local.hour * 60 + now_local.minute
    segment = _segment_for(program, weekday, minutes_now)
    if segment:
        if segment.get("temperature") is not None:
            return segment["temperature"], "schedule"
        preset = _find_preset(program, segment.get("preset_id"))
        if preset:
            return preset["temperature"], f"schedule:{preset['name']}"

    default_preset = _find_preset(program, program.get("default_preset_id"))
    if default_preset:
        return default_preset["temperature"], f"default:{default_preset['name']}"
    return None, "none"


class HeatingEngine:
    """Evaluates and applies heating programs."""

    def __init__(self, hass: HomeAssistant, store: HeatingStore) -> None:
        self.hass = hass
        self.store = store
        self._last_applied: dict[str, float] = {}
        self._unsub_tick = None

    def async_start(self) -> None:
        self._unsub_tick = async_track_time_change(self.hass, self._async_tick, second=0)

    def async_stop(self) -> None:
        if self._unsub_tick:
            self._unsub_tick()
            self._unsub_tick = None

    async def _async_tick(self, _now_utc: datetime) -> None:
        now_local = dt_util.now()
        for program in list(self.store.programs.values()):
            if not program.get("enabled"):
                continue
            await self._expire_override_if_needed(program, now_local)
            if not program.get("climate_entities"):
                continue
            temperature, source = resolve_target_temperature(program, now_local)
            if temperature is None:
                continue
            await self._apply_if_changed(program, temperature, source)

    async def _expire_override_if_needed(self, program: dict[str, Any], now_local: datetime) -> None:
        override = program.get("override")
        if not override:
            return
        until_raw = override.get("until")
        if not until_raw:
            return
        until_dt = dt_util.parse_datetime(until_raw)
        if until_dt and now_local >= until_dt:
            program["override"] = None
            await self.store.async_save()
            async_dispatcher_send(self.hass, SIGNAL_HEATING_UPDATED)

    async def _apply_if_changed(self, program: dict[str, Any], temperature: float, source: str) -> None:
        if self._last_applied.get(program["id"]) == temperature:
            return
        for entity_id in program.get("climate_entities", []):
            try:
                await self.hass.services.async_call(
                    "climate",
                    "set_temperature",
                    {"entity_id": entity_id, "temperature": temperature},
                    blocking=False,
                )
                if program.get("hvac_mode"):
                    await self.hass.services.async_call(
                        "climate",
                        "set_hvac_mode",
                        {"entity_id": entity_id, "hvac_mode": program["hvac_mode"]},
                        blocking=False,
                    )
            except Exception:  # noqa: BLE001 - never let one bad entity kill the engine
                _LOGGER.exception(
                    "Failed to apply heating program %s to %s", program.get("name"), entity_id
                )
        self._last_applied[program["id"]] = temperature
        self.hass.bus.async_fire(
            EVENT_HEATING_APPLIED,
            {"program_id": program["id"], "temperature": temperature, "source": source},
        )
        async_dispatcher_send(self.hass, SIGNAL_HEATING_UPDATED)

    async def _force_reapply(self, program_id: str, temperature: float, source: str) -> None:
        program = self.store.async_get(program_id)
        if program is None:
            return
        self._last_applied.pop(program_id, None)
        await self._apply_if_changed(program, temperature, source)

    async def async_boost(self, program_id: str, temperature: float, minutes: int) -> bool:
        """Temporarily hold a temperature for a number of minutes, then revert."""
        until = dt_util.now() + timedelta(minutes=minutes)
        program = await self.store.async_set_override(
            program_id, {"type": "boost", "temperature": temperature, "until": until.isoformat()}
        )
        if program is None:
            return False
        async_dispatcher_send(self.hass, SIGNAL_HEATING_UPDATED)
        await self._force_reapply(program_id, temperature, "boost")
        return True

    async def async_set_override(
        self, program_id: str, temperature: float, until_iso: str | None = None
    ) -> bool:
        """Hold a temperature indefinitely (until_iso=None) or until a given time."""
        program = await self.store.async_set_override(
            program_id, {"type": "hold", "temperature": temperature, "until": until_iso}
        )
        if program is None:
            return False
        async_dispatcher_send(self.hass, SIGNAL_HEATING_UPDATED)
        await self._force_reapply(program_id, temperature, "hold")
        return True

    async def async_clear_override(self, program_id: str) -> bool:
        program = await self.store.async_set_override(program_id, None)
        if program is None:
            return False
        async_dispatcher_send(self.hass, SIGNAL_HEATING_UPDATED)
        now_local = dt_util.now()
        temperature, source = resolve_target_temperature(program, now_local)
        if temperature is not None:
            await self._force_reapply(program_id, temperature, source)
        return True
