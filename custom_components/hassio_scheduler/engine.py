"""The scheduling engine.

Schedules are evaluated on a one-minute tick. This is deliberately simple
(rather than pre-computing exact "next fire" timers) because it trivially
handles schedule edits, HA restarts, DST changes and sun-event schedules
without any special-casing: every minute we ask "does anything match right
now?" and run it. A best-effort "next run" is computed separately purely
for display purposes (sensors / the frontend calendar).

Actions are executed with :class:`homeassistant.helpers.script.Script`,
meaning a timeslot's actions can be a full HA action/script sequence
(service calls, delays, conditions, choose/repeat blocks, etc.) - the same
engine automations use.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import sun as sun_helper
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.script import Script
import homeassistant.util.dt as dt_util

from .const import DOMAIN, EVENT_SKIPPED, EVENT_TRIGGERED, SIGNAL_SCHEDULES_UPDATED, WEEKDAYS
from .store import ScheduleStore

_LOGGER = logging.getLogger(__name__)


def _resolve_time_spec(
    hass: HomeAssistant, spec: dict[str, Any] | None, for_date: date
) -> datetime | None:
    """Resolve a time spec (clock time or sun event) to a local datetime on for_date."""
    if not spec:
        return None
    kind = spec.get("kind")
    if kind == "time":
        raw = spec.get("at")
        parsed = dt_util.parse_time(raw) if raw else None
        if parsed is None:
            return None
        local_tz = dt_util.get_time_zone(hass.config.time_zone) or dt_util.DEFAULT_TIME_ZONE
        return datetime.combine(for_date, parsed, tzinfo=local_tz)
    if kind == "sun":
        event = "sunrise" if spec.get("event") == "sunrise" else "sunset"
        base_utc = sun_helper.get_astral_event_date(hass, event, for_date)
        if base_utc is None:
            # Sun never rises/sets on this date at this location (polar regions)
            return None
        offset = timedelta(minutes=spec.get("offset_minutes", 0) or 0)
        return dt_util.as_local(base_utc + offset)
    return None


def _same_minute(a: datetime | None, b: datetime) -> bool:
    if a is None:
        return False
    return a.astimezone(b.tzinfo).replace(second=0, microsecond=0) == b.replace(
        second=0, microsecond=0
    )


def _slot_active_on(schedule: dict[str, Any], slot: dict[str, Any], on_date: date) -> bool:
    start_date = schedule.get("start_date")
    end_date = schedule.get("end_date")
    if start_date and on_date < date.fromisoformat(start_date):
        return False
    if end_date and on_date > date.fromisoformat(end_date):
        return False
    if slot.get("recurrence") == "once":
        return slot.get("date") == on_date.isoformat()
    weekday = WEEKDAYS[on_date.weekday()]
    return weekday in (slot.get("weekdays") or [])


def _candidate_occurrence(
    hass: HomeAssistant, schedule: dict[str, Any], slot: dict[str, Any], base_date: date
) -> tuple[datetime, datetime | None] | None:
    """Return (start, end) for slot's occurrence anchored on base_date, if it applies."""
    if not _slot_active_on(schedule, slot, base_date):
        return None
    start_dt = _resolve_time_spec(hass, slot.get("start"), base_date)
    if start_dt is None:
        return None
    end_dt = _resolve_time_spec(hass, slot.get("end"), base_date)
    if end_dt is not None and end_dt <= start_dt:
        end_dt = end_dt + timedelta(days=1)
    return start_dt, end_dt


class SchedulerEngine:
    """Evaluates and fires schedules."""

    def __init__(self, hass: HomeAssistant, store: ScheduleStore) -> None:
        self.hass = hass
        self.store = store
        self.last_triggered: dict[str, str] = {}
        self._unsub_tick = None
        self._fired_this_minute: set[tuple[str, str, str]] = set()
        self._fired_minute_key: str | None = None

    def async_start(self) -> None:
        """Start the one-minute evaluation tick."""
        self._unsub_tick = async_track_time_change(self.hass, self._async_tick, second=0)

    def async_stop(self) -> None:
        if self._unsub_tick:
            self._unsub_tick()
            self._unsub_tick = None

    async def _async_tick(self, _now_utc: datetime) -> None:
        now_local = dt_util.now()
        minute_key = now_local.strftime("%Y-%m-%dT%H:%M")
        if minute_key != self._fired_minute_key:
            self._fired_minute_key = minute_key
            self._fired_this_minute = set()

        today = now_local.date()
        yesterday = today - timedelta(days=1)

        for schedule in list(self.store.schedules.values()):
            if not schedule.get("enabled"):
                continue
            for slot in schedule.get("timeslots", []):
                for base_date in (today, yesterday):
                    occurrence = _candidate_occurrence(self.hass, schedule, slot, base_date)
                    if occurrence is None:
                        continue
                    start_dt, end_dt = occurrence
                    if base_date == today and _same_minute(start_dt, now_local):
                        await self._maybe_fire(schedule, slot, "start", now_local)
                    if end_dt is not None and _same_minute(end_dt, now_local):
                        await self._maybe_fire(schedule, slot, "end", now_local)

    async def _maybe_fire(
        self, schedule: dict[str, Any], slot: dict[str, Any], phase: str, now_local: datetime
    ) -> None:
        fire_key = (schedule["id"], slot["id"], phase)
        if fire_key in self._fired_this_minute:
            return
        self._fired_this_minute.add(fire_key)
        await self._fire(schedule, slot, phase, now_local)

    async def _fire(
        self, schedule: dict[str, Any], slot: dict[str, Any], phase: str, now_local: datetime
    ) -> None:
        actions = slot.get("actions") if phase == "start" else slot.get("end_actions")
        actions = actions or []

        self.hass.bus.async_fire(
            EVENT_TRIGGERED,
            {
                "schedule_id": schedule["id"],
                "schedule_name": schedule.get("name"),
                "timeslot_id": slot["id"],
                "phase": phase,
            },
        )
        _LOGGER.debug(
            "Firing schedule %s slot %s phase=%s with %d action(s)",
            schedule.get("name"),
            slot["id"],
            phase,
            len(actions),
        )

        if actions:
            script_obj = Script(
                self.hass,
                actions,
                f"{schedule.get('name', 'schedule')} ({phase})",
                DOMAIN,
            )
            try:
                await script_obj.async_run(context=Context())
            except Exception:  # noqa: BLE001 - never let a bad schedule kill the engine
                _LOGGER.exception(
                    "Error running actions for schedule %s (%s)", schedule.get("name"), phase
                )
        else:
            self.hass.bus.async_fire(
                EVENT_SKIPPED,
                {"schedule_id": schedule["id"], "timeslot_id": slot["id"], "phase": phase},
            )

        self.last_triggered[schedule["id"]] = now_local.isoformat()

        if phase == "start" and slot.get("once"):
            schedule["enabled"] = False
            await self.store.async_save()

        async_dispatcher_send(self.hass, SIGNAL_SCHEDULES_UPDATED)

    async def async_run_now(self, schedule_id: str, timeslot_id: str | None = None) -> bool:
        """Manually run a schedule's actions immediately, bypassing time checks."""
        schedule = self.store.async_get(schedule_id)
        if schedule is None:
            return False
        now_local = dt_util.now()
        slots = schedule.get("timeslots", [])
        if timeslot_id:
            slots = [s for s in slots if s["id"] == timeslot_id]
        if not slots:
            return False
        for slot in slots:
            await self._fire(schedule, slot, "start", now_local)
        return True

    def compute_next_run(self, schedule: dict[str, Any], horizon_days: int = 14) -> str | None:
        """Best-effort next start time for display purposes."""
        if not schedule.get("enabled"):
            return None
        now_local = dt_util.now()
        best: datetime | None = None
        for day_offset in range(horizon_days + 1):
            check_date = now_local.date() + timedelta(days=day_offset)
            for slot in schedule.get("timeslots", []):
                occurrence = _candidate_occurrence(self.hass, schedule, slot, check_date)
                if occurrence is None:
                    continue
                start_dt = occurrence[0]
                if start_dt < now_local:
                    continue
                if best is None or start_dt < best:
                    best = start_dt
            if best is not None:
                # All slots for this day have been considered, and any future
                # day is strictly later, so this is the earliest possible.
                break
        return best.isoformat() if best else None
