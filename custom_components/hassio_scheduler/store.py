"""Persistent storage for schedules.

Schedule data model (stored as plain dicts, JSON-serialisable):

{
  "id": "uuid4",
  "name": "Evening lights",
  "icon": "mdi:lightbulb",
  "color": "#03a9f4",
  "enabled": True,
  "start_date": "2026-01-01" | None,   # optional overall active window
  "end_date": "2026-12-31" | None,
  "skip_dates": ["2026-12-25"],        # dates this schedule never fires on
  "timeslots": [
    {
      "id": "uuid4",
      "recurrence": "weekly" | "once",
      "weekdays": ["mon", "tue", ...],   # used when recurrence == weekly
      "date": "2026-08-05" | None,       # used when recurrence == once
      "start": {"kind": "time", "at": "18:30:00"}
               | {"kind": "sun", "event": "sunset", "offset_minutes": -15},
      "end": null | {same shape as start},
      "actions": [ ...HA action/script sequence... ],
      "end_actions": [ ...HA action/script sequence... ] | [],
      "once": False,   # disable schedule automatically after this slot fires
    }
  ]
}
"""
from __future__ import annotations

import uuid
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY_SCHEDULES, STORAGE_VERSION


def new_id() -> str:
    """Generate a new random id."""
    return uuid.uuid4().hex


class ScheduleStore:
    """Wrapper around the HA Store helper that keeps schedules in memory."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_SCHEDULES)
        self.schedules: dict[str, dict[str, Any]] = {}

    async def async_load(self) -> None:
        """Load schedules from disk."""
        data = await self._store.async_load()
        schedules = (data or {}).get("schedules", []) if isinstance(data, dict) else []
        self.schedules = {s["id"]: s for s in schedules}

    async def async_save(self) -> None:
        """Persist schedules to disk."""
        await self._store.async_save({"schedules": list(self.schedules.values())})

    def async_list(self) -> list[dict[str, Any]]:
        """Return all schedules."""
        return list(self.schedules.values())

    def async_get(self, schedule_id: str) -> dict[str, Any] | None:
        """Return a single schedule."""
        return self.schedules.get(schedule_id)

    async def async_create(self, data: dict[str, Any]) -> dict[str, Any]:
        """Create a new schedule."""
        schedule = _normalize_schedule(data)
        schedule["id"] = new_id()
        for slot in schedule["timeslots"]:
            slot.setdefault("id", new_id())
        self.schedules[schedule["id"]] = schedule
        await self.async_save()
        return schedule

    async def async_update(self, schedule_id: str, data: dict[str, Any]) -> dict[str, Any]:
        """Update an existing schedule."""
        if schedule_id not in self.schedules:
            raise KeyError(schedule_id)
        schedule = _normalize_schedule(data)
        schedule["id"] = schedule_id
        for slot in schedule["timeslots"]:
            slot.setdefault("id", new_id())
        self.schedules[schedule_id] = schedule
        await self.async_save()
        return schedule

    async def async_delete(self, schedule_id: str) -> None:
        """Delete a schedule."""
        self.schedules.pop(schedule_id, None)
        await self.async_save()

    async def async_set_enabled(self, schedule_id: str, enabled: bool) -> dict[str, Any] | None:
        """Enable or disable a schedule."""
        schedule = self.schedules.get(schedule_id)
        if schedule is None:
            return None
        schedule["enabled"] = enabled
        await self.async_save()
        return schedule


def _normalize_schedule(data: dict[str, Any]) -> dict[str, Any]:
    """Fill in defaults / coerce types for a schedule payload."""
    schedule = {
        "id": data.get("id") or new_id(),
        "name": data.get("name") or "New schedule",
        "icon": data.get("icon") or "mdi:calendar-clock",
        "color": data.get("color") or "#03a9f4",
        "enabled": bool(data.get("enabled", True)),
        "start_date": data.get("start_date"),
        "end_date": data.get("end_date"),
        "skip_dates": sorted(set(data.get("skip_dates") or [])),
        "timeslots": [],
    }
    for slot in data.get("timeslots", []):
        schedule["timeslots"].append(_normalize_timeslot(slot))
    return schedule


def _normalize_timeslot(slot: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": slot.get("id") or new_id(),
        "recurrence": slot.get("recurrence") or "weekly",
        "weekdays": slot.get("weekdays") or [],
        "date": slot.get("date"),
        "start": slot.get("start"),
        "end": slot.get("end"),
        "actions": slot.get("actions") or [],
        "end_actions": slot.get("end_actions") or [],
        "once": bool(slot.get("once", False)),
    }
