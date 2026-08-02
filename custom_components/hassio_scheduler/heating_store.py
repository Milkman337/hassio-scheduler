"""Persistent storage for heating programs.

A heating program drives one or more `climate` entities from a weekly
temperature grid - one sorted, non-overlapping list of segments per weekday,
each referencing a preset (or carrying its own one-off temperature):

{
  "id": "uuid4",
  "name": "Living room",
  "icon": "mdi:radiator",
  "color": "#ff7043",
  "enabled": True,
  "climate_entities": ["climate.living_room"],
  "hvac_mode": "heat" | None,
  "presets": [{"id": "comfort", "name": "Comfort", "temperature": 21,
                "color": "#ffb74d", "icon": "mdi:sofa"}, ...],
  "default_preset_id": "eco",
  "grid": {
    "mon": [{"start": "06:00", "end": "08:00", "preset_id": "comfort",
              "temperature": None}, ...],
    "tue": [...], ... "sun": [...]
  },
  "override": None | {"type": "boost" | "hold", "temperature": 23,
                       "until": "2026-08-02T18:00:00+02:00" | None}
}
"""
from __future__ import annotations

import uuid
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DEFAULT_HEATING_PRESETS, STORAGE_KEY_HEATING, STORAGE_VERSION, WEEKDAYS


def new_id() -> str:
    return uuid.uuid4().hex


class HeatingStore:
    """Wrapper around the HA Store helper that keeps heating programs in memory."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_HEATING)
        self.programs: dict[str, dict[str, Any]] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load()
        programs = (data or {}).get("programs", []) if isinstance(data, dict) else []
        self.programs = {p["id"]: p for p in programs}

    async def async_save(self) -> None:
        await self._store.async_save({"programs": list(self.programs.values())})

    def async_list(self) -> list[dict[str, Any]]:
        return list(self.programs.values())

    def async_get(self, program_id: str) -> dict[str, Any] | None:
        return self.programs.get(program_id)

    async def async_create(self, data: dict[str, Any]) -> dict[str, Any]:
        program = _normalize_program(data)
        program["id"] = new_id()
        self.programs[program["id"]] = program
        await self.async_save()
        return program

    async def async_update(self, program_id: str, data: dict[str, Any]) -> dict[str, Any]:
        if program_id not in self.programs:
            raise KeyError(program_id)
        existing = self.programs[program_id]
        program = _normalize_program(data)
        program["id"] = program_id
        # Overrides are managed separately (boost/hold/clear) - never clobbered by a plain edit.
        program["override"] = existing.get("override")
        self.programs[program_id] = program
        await self.async_save()
        return program

    async def async_delete(self, program_id: str) -> None:
        self.programs.pop(program_id, None)
        await self.async_save()

    async def async_set_enabled(self, program_id: str, enabled: bool) -> dict[str, Any] | None:
        program = self.programs.get(program_id)
        if program is None:
            return None
        program["enabled"] = enabled
        await self.async_save()
        return program

    async def async_set_override(self, program_id: str, override: dict[str, Any] | None) -> dict[str, Any] | None:
        program = self.programs.get(program_id)
        if program is None:
            return None
        program["override"] = override
        await self.async_save()
        return program


def _normalize_program(data: dict[str, Any]) -> dict[str, Any]:
    presets = data.get("presets") or [dict(p) for p in DEFAULT_HEATING_PRESETS]
    preset_ids = {p.get("id") for p in presets}
    default_preset_id = data.get("default_preset_id")
    if default_preset_id not in preset_ids:
        default_preset_id = presets[0]["id"] if presets else None

    grid_in = data.get("grid") or {}
    grid: dict[str, list[dict[str, Any]]] = {}
    for day in WEEKDAYS:
        segments = []
        for seg in grid_in.get(day, []) or []:
            segments.append(
                {
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "preset_id": seg.get("preset_id"),
                    "temperature": seg.get("temperature"),
                }
            )
        grid[day] = segments

    return {
        "id": data.get("id") or new_id(),
        "name": data.get("name") or "New heating program",
        "icon": data.get("icon") or "mdi:radiator",
        "color": data.get("color") or "#ff7043",
        "enabled": bool(data.get("enabled", True)),
        "climate_entities": list(data.get("climate_entities") or []),
        "hvac_mode": data.get("hvac_mode"),
        "presets": presets,
        "default_preset_id": default_preset_id,
        "grid": grid,
        "override": data.get("override"),
    }
